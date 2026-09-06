import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Harness } from "../shared/types.js";

// A menu-bar app inherits a bare PATH, so look in the usual install dirs too.
const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export function editorCandidates(harness: Harness, env = process.env): string[] {
  const preferred = env.SIDECAR_EDITOR?.trim();
  const names = harness === "cursor" ? ["cursor", "code"] : ["code", "cursor"];
  return [...(preferred ? [preferred] : []), ...names, "zed", "subl"];
}

export function searchDirs(env = process.env): string[] {
  const fromPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...EXTRA_DIRS])];
}

export function findExecutable(name: string, dirs = searchDirs()): string | null {
  if (name.includes(path.sep)) {
    return isExecutable(name) ? name : null;
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function existingDir(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return fs.statSync(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}

// Detached so a blocking editor CLI can never hang the panel.
export function launch(command: string, args: string[]): void {
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
