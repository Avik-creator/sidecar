import os from "node:os";
import path from "node:path";

export function homeDir(): string {
  return os.homedir();
}

export function sidecarHome(): string {
  return process.env.SIDECAR_HOME?.trim() || path.join(homeDir(), ".sidecar");
}

export function dbPath(): string {
  return path.join(sidecarHome(), "sidecar.sqlite");
}

export function settingsPath(): string {
  return path.join(sidecarHome(), "settings.json");
}

export function backupDir(): string {
  return path.join(sidecarHome(), "backups");
}

// One file per hook event, so concurrent agents never interleave writes.
export function hooksSpoolDir(): string {
  return path.join(sidecarHome(), "hooks");
}

export function hookHelperPath(): string {
  return path.join(sidecarHome(), "bin", "sidecar-hook");
}

export function claudeRoot(): string {
  return path.join(homeDir(), ".claude");
}

export function claudeProjectsDir(): string {
  return path.join(claudeRoot(), "projects");
}

export function codexRoot(): string {
  return path.join(homeDir(), ".codex");
}

export function codexSessionsDir(): string {
  return path.join(codexRoot(), "sessions");
}

export function cursorUserDir(): string {
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support", "Cursor", "User");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "User");
  }
  return path.join(homeDir(), ".config", "Cursor", "User");
}

export function cursorStateDb(): string {
  return path.join(cursorUserDir(), "globalStorage", "state.vscdb");
}

export function cursorHome(): string {
  return path.join(homeDir(), ".cursor");
}

export function displayTimezone(): string {
  return process.env.SIDECAR_TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
