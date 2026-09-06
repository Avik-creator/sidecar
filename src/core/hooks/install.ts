import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { backupDir, claudeRoot, codexRoot, cursorHome, hookHelperPath } from "../paths.js";
import { asRecord } from "../text.js";
import type { Harness, HookStatus } from "../../shared/types.js";
import { HOOK_HELPER_SCRIPT } from "./helper.js";
import { installedEvents } from "./events.js";

export interface HookInstallPaths {
  helper: string;
  backups: string;
  configs: Record<Harness, string>;
}

export function hookInstallPaths(): HookInstallPaths {
  return {
    helper: hookHelperPath(),
    backups: backupDir(),
    configs: {
      claude: path.join(claudeRoot(), "settings.json"),
      codex: path.join(codexRoot(), "hooks.json"),
      cursor: path.join(cursorHome(), "hooks.json"),
    },
  };
}

export function writeHelper(paths: HookInstallPaths): void {
  fs.mkdirSync(path.dirname(paths.helper), { recursive: true });
  atomicWrite(paths.helper, HOOK_HELPER_SCRIPT);
  fs.chmodSync(paths.helper, 0o755);
}

export function hooksStatus(paths = hookInstallPaths()): HookStatus[] {
  return harnesses().map((harness) => inspect(harness, paths));
}

export function installHooks(paths = hookInstallPaths()): HookStatus[] {
  writeHelper(paths);
  for (const harness of harnesses()) {
    const configPath = paths.configs[harness];
    const doc = readConfig(configPath);
    const next = addOurEntries(harness, doc, paths.helper);
    writeConfig(configPath, next, paths.backups);
  }
  return hooksStatus(paths);
}

export function uninstallHooks(paths = hookInstallPaths()): HookStatus[] {
  for (const harness of harnesses()) {
    const configPath = paths.configs[harness];
    if (!fs.existsSync(configPath)) {
      continue;
    }
    const doc = readConfig(configPath);
    writeConfig(configPath, stripOurEntries(doc, paths.helper), paths.backups);
  }
  fs.rmSync(paths.helper, { force: true });
  return hooksStatus(paths);
}

function harnesses(): Harness[] {
  return ["claude", "codex", "cursor"];
}

function inspect(harness: Harness, paths: HookInstallPaths): HookStatus {
  const configPath = paths.configs[harness];
  const wanted = installedEvents(harness);
  const doc = readConfig(configPath);
  const hooks = asRecord(doc.hooks) ?? {};
  const present: string[] = [];
  let foreignEntries = 0;
  for (const [event, value] of Object.entries(hooks)) {
    const entries = Array.isArray(value) ? value : [];
    let mine = false;
    for (const entry of entries) {
      if (entryIsOurs(entry, paths.helper)) {
        mine = true;
      } else {
        foreignEntries += 1;
      }
    }
    if (mine && wanted.includes(event)) {
      present.push(event);
    }
  }
  const missing = wanted.filter((event) => !present.includes(event));
  return {
    harness,
    configPath,
    installed: missing.length === 0 && present.length > 0,
    present,
    missing,
    foreignEntries,
    note:
      harness === "codex" && present.length > 0
        ? "Run /hooks inside Codex and trust the Sidecar entries before they fire."
        : null,
  };
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = parseJsonc(fs.readFileSync(configPath, "utf8")) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function writeConfig(configPath: string, doc: Record<string, unknown>, backups: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    fs.mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(configPath, path.join(backups, `${path.basename(configPath)}.${stamp}.bak`));
  }
  atomicWrite(configPath, `${JSON.stringify(doc, null, 2)}\n`);
}

function addOurEntries(
  harness: Harness,
  doc: Record<string, unknown>,
  helper: string,
): Record<string, unknown> {
  const next = { ...doc };
  if (harness === "cursor" && next.version == null) {
    next.version = 1;
  }
  const hooks: Record<string, unknown> = { ...(asRecord(next.hooks) ?? {}) };
  for (const event of installedEvents(harness)) {
    const existing = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const kept = existing.filter((entry) => !entryIsOurs(entry, helper));
    kept.push(newEntry(harness, event, helper));
    hooks[event] = kept;
  }
  next.hooks = hooks;
  return next;
}

function stripOurEntries(doc: Record<string, unknown>, helper: string): Record<string, unknown> {
  const next = { ...doc };
  const hooks = asRecord(next.hooks);
  if (!hooks) {
    return next;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      cleaned[event] = value;
      continue;
    }
    const kept = value.filter((entry) => !entryIsOurs(entry, helper));
    if (kept.length > 0) {
      cleaned[event] = kept;
    }
  }
  next.hooks = cleaned;
  return next;
}

// Cursor takes a flat array of hook objects; Claude and Codex nest them under a matcher group.
function newEntry(harness: Harness, event: string, helper: string): unknown {
  const command = `${shellQuote(helper)} ${harness} ${event}`;
  if (harness === "cursor") {
    return { id: "sidecar", type: "command", command, timeout: 5 };
  }
  return { hooks: [{ type: "command", command, async: true, timeout: 5 }] };
}

function entryIsOurs(entry: unknown, helper: string): boolean {
  const rec = asRecord(entry);
  if (!rec) {
    return false;
  }
  if (rec.id === "sidecar") {
    return true;
  }
  if (typeof rec.command === "string" && rec.command.includes(helper)) {
    return true;
  }
  const nested = rec.hooks;
  if (Array.isArray(nested)) {
    return nested.some((child) => {
      const childRec = asRecord(child);
      return typeof childRec?.command === "string" && childRec.command.includes(helper);
    });
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function atomicWrite(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.sidecar-${path.basename(filePath)}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}
