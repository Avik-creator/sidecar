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

export function lockPath(): string {
  return path.join(sidecarHome(), "sidecar.lock");
}

export function backupDir(): string {
  return path.join(sidecarHome(), "backups");
}

export function hooksLogPath(): string {
  return path.join(sidecarHome(), "hooks.jsonl");
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
