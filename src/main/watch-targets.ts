import path from "node:path";
import { claudeProjectsDir, codexSessionsDir, cursorStateDb, hooksSpoolDir } from "../core/paths.js";

export interface WatchPaths {
  claudeDir: string;
  codexDir: string;
  cursorDb: string;
  spoolDir: string;
}

export function watchPaths(): WatchPaths {
  return {
    claudeDir: claudeProjectsDir(),
    codexDir: codexSessionsDir(),
    cursorDb: cursorStateDb(),
    spoolDir: hooksSpoolDir(),
  };
}

// chokidar v4 dropped glob support, so we watch directories and filter changes ourselves.
export function watchRoots(paths: WatchPaths): string[] {
  return [paths.claudeDir, paths.codexDir, paths.cursorDb, `${paths.cursorDb}-wal`, paths.spoolDir];
}

export function isRelevantChange(filePath: string, paths: WatchPaths): boolean {
  if (filePath === paths.cursorDb || filePath === `${paths.cursorDb}-wal`) {
    return true;
  }
  if (isInside(filePath, paths.spoolDir)) {
    return filePath.endsWith(".json");
  }
  if (!filePath.endsWith(".jsonl")) {
    return false;
  }
  return isInside(filePath, paths.claudeDir) || isInside(filePath, paths.codexDir);
}

function isInside(filePath: string, dir: string): boolean {
  return filePath.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`);
}
