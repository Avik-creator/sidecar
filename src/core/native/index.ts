import type { Store } from "../db/store.js";
import { claudeSessionsDir, codexRoot, cursorStateDb } from "../paths.js";
import { readClaudeRegistry } from "./claude.js";
import { readCodexThreads } from "./codex.js";
import { readCursorComposers } from "./cursor.js";
import { findProcessPid, isProcessAlive, type AliveCheck } from "./process.js";
import type { NativeState } from "./state.js";

export interface NativeStateOptions {
  claudeSessionsDir?: string;
  codexRoot?: string;
  cursorDb?: string;
  alive?: AliveCheck;
  // Pid of the running Cursor app, or null when it is not running; undefined asks pgrep.
  cursorPid?: number | null;
}

export interface NativeStateReport {
  states: number;
  errors: string[];
}

// Reads every harness's own state files and writes what they say into the store.
export function applyNativeStates(store: Store, options: NativeStateOptions = {}): NativeStateReport {
  const alive = options.alive ?? isProcessAlive;
  const errors: string[] = [];
  const states: NativeState[] = [];
  const readers: Array<[string, () => NativeState[]]> = [
    ["claude", () => readClaudeRegistry(options.claudeSessionsDir ?? claudeSessionsDir(), alive)],
    ["codex", () => readCodexThreads(options.codexRoot ?? codexRoot())],
    [
      "cursor",
      () => {
        const pid = options.cursorPid === undefined ? findProcessPid("Cursor") : options.cursorPid;
        // Without pgrep there is no way to tell a closed Cursor from a running one.
        const appAlive = pid != null ? true : process.platform === "win32" ? null : false;
        return readCursorComposers(options.cursorDb ?? cursorStateDb(), pid, appAlive);
      },
    ],
  ];
  for (const [name, read] of readers) {
    try {
      states.push(...read());
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  store.transaction(() => {
    for (const state of states) {
      store.applyState({
        sessionId: `${state.harness}:${state.nativeId}`,
        harness: state.harness,
        nativeId: state.nativeId,
        cwd: state.cwd,
        title: state.title,
        state: state.state,
        hasBlocking: state.hasBlocking,
        ts: state.ts,
        eventType: state.eventType,
        source: state.source,
        pid: state.pid,
        parentId: state.parentId,
        agentType: state.agentType,
        facts: state.facts,
      });
    }
  });
  return { states: states.length, errors };
}
