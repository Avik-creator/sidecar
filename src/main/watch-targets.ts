import path from "node:path";
import {
  claudeProjectsDir,
  claudeSessionsDir,
  codexSessionsDir,
  codexThreadHistoryDb,
  codexThreadLocksDir,
  cursorStateDb,
  hooksSpoolDir,
} from "../core/paths.js";

export interface WatchPaths {
  claudeDir: string;
  claudeSessionsDir: string;
  codexDir: string;
  codexHistoryDb: string;
  codexLocksDir: string;
  cursorDb: string;
  spoolDir: string;
}

export function watchPaths(): WatchPaths {
  return {
    claudeDir: claudeProjectsDir(),
    claudeSessionsDir: claudeSessionsDir(),
    codexDir: codexSessionsDir(),
    codexHistoryDb: codexThreadHistoryDb(),
    codexLocksDir: codexThreadLocksDir(),
    cursorDb: cursorStateDb(),
    spoolDir: hooksSpoolDir(),
  };
}

// chokidar v4 dropped glob support, so we watch directories and filter changes ourselves.
export function watchRoots(paths: WatchPaths): string[] {
  return [
    paths.claudeDir,
    paths.claudeSessionsDir,
    paths.codexDir,
    paths.codexHistoryDb,
    `${paths.codexHistoryDb}-wal`,
    paths.codexLocksDir,
    paths.cursorDb,
    `${paths.cursorDb}-wal`,
    paths.spoolDir,
  ];
}

export function isRelevantChange(filePath: string, paths: WatchPaths): boolean {
  if (filePath === paths.cursorDb || filePath === `${paths.cursorDb}-wal`) {
    return true;
  }
  if (filePath === paths.codexHistoryDb || filePath === `${paths.codexHistoryDb}-wal`) {
    return true;
  }
  if (isInside(filePath, paths.spoolDir) || isInside(filePath, paths.claudeSessionsDir)) {
    return filePath.endsWith(".json");
  }
  if (isInside(filePath, paths.codexLocksDir)) {
    return filePath.endsWith(".lock");
  }
  if (!filePath.endsWith(".jsonl")) {
    return false;
  }
  return isInside(filePath, paths.claudeDir) || isInside(filePath, paths.codexDir);
}

function isInside(filePath: string, dir: string): boolean {
  return filePath.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`);
}
