import { app, BrowserWindow, ipcMain, Menu, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import chokidar from "chokidar";
import { SidecarService } from "../core/app.js";
import {
  claudeProjectsDir,
  codexSessionsDir,
  cursorStateDb,
  hooksLogPath,
} from "../core/paths.js";
import { IngestWorkerClient } from "./ingest-worker-client.js";
import { createTrayImage } from "./tray-icon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 700;
const POLL_INTERVAL_MS = 1000;
const TRAY_REFRESH_INTERVAL_MS = 5000;

let service: SidecarService | null = null;
let ingestWorker: IngestWorkerClient | null = null;
let panel: BrowserWindow | null = null;
let tray: Tray | null = null;
let ingestTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pinned = false;
let ignoreBlurUntil = 0;
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;
let lastSourceSignature = "";
let lastTrayRefreshAt = 0;

function resolvePreload(): string {
  const candidates = [
    path.join(__dirname, "../preload/index.mjs"),
    path.join(__dirname, "../preload/index.js"),
  ];
  const found = candidates.find((filePath) => fs.existsSync(filePath));
  if (!found) {
    throw new Error(`preload script missing, looked in ${candidates.join(", ")}`);
  }
  return found;
}

function createPanel(): BrowserWindow {
  const window = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    movable: true,
    alwaysOnTop: true,
    hiddenInMissionControl: true,
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: "#f4efe6",
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("renderer failed", code, description, url);
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") {
      console.error("renderer", details.message);
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("close", (event) => {
    event.preventDefault();
    window.hide();
  });

  window.on("blur", () => {
    if (!pinned && Date.now() > ignoreBlurUntil) {
      window.hide();
    }
  });

  return window;
}

function positionPanel(): void {
  if (!panel || !tray) {
    return;
  }
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_WIDTH / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 6);
  const maxX = display.workArea.x + display.workArea.width - PANEL_WIDTH - 8;
  const minX = display.workArea.x + 8;
  panel.setPosition(Math.min(Math.max(x, minX), maxX), y, false);
}

function togglePanel(): void {
  if (!panel) {
    return;
  }
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  ignoreBlurUntil = Date.now() + 800;
  positionPanel();
  panel.show();
  panel.focus();
  panel.webContents.send("sidecar:changed");
}

function getService(): SidecarService {
  if (!service) {
    service = SidecarService.open();
  }
  return service;
}

function getIngestWorker(): IngestWorkerClient {
  if (!ingestWorker) {
    const workerUrl = app.isPackaged
      ? pathToFileURL(path.join(process.resourcesPath, "app.asar.unpacked", "out/main/ingest-worker.js"))
      : new URL("./ingest-worker.js", import.meta.url);
    ingestWorker = new IngestWorkerClient(workerUrl);
  }
  return ingestWorker;
}

function bindIpc(): void {
  const svc = getService();
  ipcMain.handle("sidecar:health", () => svc.health());
  ipcMain.handle("sidecar:ingest", () => getIngestWorker().ingest());
  ipcMain.handle("sidecar:usage", (_event, days?: number) => svc.usage(days));
  ipcMain.handle("sidecar:sessions", () => svc.sessions());
  ipcMain.handle("sidecar:setup", () => svc.setup());
  ipcMain.handle("sidecar:candidates", (_event, limit?: number) => svc.candidates(limit));
  ipcMain.handle("sidecar:clusters", () => svc.clusters());
  ipcMain.handle("sidecar:suggestions", () => svc.suggestions());
  ipcMain.handle("sidecar:runImprove", () => svc.runImprove());
  ipcMain.handle("sidecar:applySuggestion", (_event, id: string) => svc.applySuggestion(id));
  ipcMain.handle("sidecar:undoSuggestion", (_event, id: string) => svc.undoSuggestion(id));
  ipcMain.handle("sidecar:dismissSuggestion", (_event, id: string) => svc.dismissSuggestion(id));
  ipcMain.handle("sidecar:setPinned", (_event, next: boolean) => {
    pinned = next;
    panel?.setAlwaysOnTop(true);
  });
  ipcMain.handle("sidecar:hidePanel", () => {
    panel?.hide();
  });
  ipcMain.handle("sidecar:quitApp", () => {
    app.quit();
  });
}

function scheduleIngest(): void {
  if (ingestTimer) {
    clearTimeout(ingestTimer);
  }
  ingestTimer = setTimeout(() => {
    void refreshFromDisk();
  }, 150);
}

async function refreshFromDisk(): Promise<void> {
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = runRefresh();
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
  if (refreshQueued) {
    refreshQueued = false;
    await refreshFromDisk();
  }
}

async function runRefresh(): Promise<void> {
  try {
    await getIngestWorker().ingest();
    await updateTrayBadge();
    panel?.webContents.send("sidecar:changed");
  } catch (error) {
    console.error(error);
  }
}

function pollSources(): void {
  const signature = sourceSignature();
  const changed = signature !== lastSourceSignature;
  lastSourceSignature = signature;
  if (changed) {
    void refreshFromDisk();
    return;
  }
  if (Date.now() - lastTrayRefreshAt >= TRAY_REFRESH_INTERVAL_MS) {
    lastTrayRefreshAt = Date.now();
    void updateTrayBadge();
  }
}

function sourceSignature(): string {
  const parts: string[] = [];
  for (const filePath of [cursorStateDb(), `${cursorStateDb()}-wal`, hooksLogPath()]) {
    try {
      const stat = fs.statSync(filePath);
      parts.push(`${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

async function updateTrayBadge(): Promise<void> {
  if (!tray) {
    return;
  }
  const sessions = await getService().sessions();
  const attention = sessions.filter((session) => session.state === "needs_attention" || session.hasBlocking).length;
  tray.setToolTip(attention > 0 ? `Sidecar — ${attention} need you` : "Sidecar");
  tray.setTitle(attention > 0 ? String(attention) : "");
}

function watchSources(): void {
  const watcher = chokidar.watch(
    [
      path.join(claudeProjectsDir(), "**/*.jsonl"),
      path.join(codexSessionsDir(), "**/*.jsonl"),
      cursorStateDb(),
      `${cursorStateDb()}-wal`,
      hooksLogPath(),
    ],
    {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      ignored: (filePath) => shouldIgnoreWatchPath(filePath),
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 50 },
    },
  );
  watcher.on("error", (error) => {
    console.warn("watch error", error);
  });
  watcher.on("all", () => {
    scheduleIngest();
  });
  app.on("before-quit", () => {
    void watcher.close();
  });
}

function shouldIgnoreWatchPath(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return false;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      return false;
    }
    return true;
  }
}

function createTray(): void {
  tray = new Tray(createTrayImage());
  tray.setToolTip("Sidecar");
  tray.on("click", () => {
    togglePanel();
  });
  tray.on("right-click", () => {
    const menu = Menu.buildFromTemplate([
      { label: "Show agents", click: () => togglePanel() },
      { label: "Refresh", click: () => void refreshFromDisk() },
      { type: "separator" },
      { label: "Quit Sidecar", click: () => app.quit() },
    ]);
    tray?.popUpContextMenu(menu);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!panel?.isVisible()) {
      togglePanel();
    }
  });

  void app.whenReady().then(() => {
    if (process.platform === "darwin") {
      app.dock?.hide();
      app.setActivationPolicy("accessory");
    }
    bindIpc();
    panel = createPanel();
    createTray();
    watchSources();
    lastSourceSignature = sourceSignature();
    setTimeout(() => {
      void refreshFromDisk();
    }, 400);
    pollTimer = setInterval(pollSources, POLL_INTERVAL_MS);
    app.on("activate", () => {
      togglePanel();
    });
  });
}

app.on("before-quit", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  if (panel) {
    panel.removeAllListeners("close");
    panel.destroy();
    panel = null;
  }
  ingestWorker?.close();
  ingestWorker = null;
});

app.on("quit", () => {
  service?.close();
  service = null;
});
