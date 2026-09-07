import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { codexStateDb, codexThreadHistoryDb, codexThreadLocksDir } from "../paths.js";
import { asNumber, asString } from "../text.js";
import { ENDED, WORKING, YOUR_TURN, isoFromMs, type NativeState } from "./state.js";

// Threads untouched for this long are not shown as anything; their transcript row still exists.
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

interface ThreadRow {
  id: string;
  cwd: string | null;
  title: string | null;
  name?: string | null;
  agent_role?: string | null;
  agent_nickname?: string | null;
  updated_at: number;
  updated_at_ms?: number | null;
}

interface TurnRow {
  status: string;
  started_at: number | null;
  completed_at: number | null;
}

// Reads Codex's thread tables; a thread is live while Codex holds its lock file.
export function readCodexThreads(root: string, now = Date.now()): NativeState[] {
  const statePath = codexStateDb(root);
  if (!fs.existsSync(statePath)) {
    return [];
  }
  const state = openReadOnly(statePath);
  const history = fs.existsSync(codexThreadHistoryDb(root)) ? openReadOnly(codexThreadHistoryDb(root)) : null;
  try {
    const threads = state
      .prepare(`SELECT * FROM threads WHERE archived = 0 AND updated_at >= ?`)
      .all(Math.floor((now - RECENT_MS) / 1000)) as unknown as ThreadRow[];
    const parents = spawnParents(state);
    const locks = lockedThreads(codexThreadLocksDir(root));
    const latestTurn = history?.prepare(
      `SELECT status, started_at, completed_at FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1`,
    );
    const out: NativeState[] = [];
    for (const thread of threads) {
      const turn = (latestTurn?.get(thread.id) as TurnRow | undefined) ?? null;
      out.push(toState(thread, turn, locks.has(thread.id), parents.get(thread.id) ?? null));
    }
    return out;
  } finally {
    state.close();
    history?.close();
  }
}

function toState(thread: ThreadRow, turn: TurnRow | null, locked: boolean, parent: string | null): NativeState {
  const updated = isoFromMs(asNumber(thread.updated_at_ms) || thread.updated_at * 1000);
  let outcome: { state: NativeState["state"]; hasBlocking: boolean } = ENDED;
  let ts = updated;
  let eventType = "thread:closed";
  if (locked && turn?.status === "inProgress") {
    outcome = WORKING;
    ts = isoFromMs((turn.started_at ?? 0) * 1000) ?? updated;
    eventType = "turn:inProgress";
  } else if (locked) {
    outcome = YOUR_TURN;
    ts = isoFromMs((turn?.completed_at ?? 0) * 1000) ?? updated;
    eventType = turn ? `turn:${turn.status}` : "thread:open";
  }
  return {
    harness: "codex",
    nativeId: thread.id,
    cwd: asString(thread.cwd),
    title: asString(thread.name) ?? asString(thread.title)?.slice(0, 90) ?? null,
    state: outcome.state,
    hasBlocking: outcome.hasBlocking,
    ts: ts ?? new Date().toISOString(),
    eventType,
    source: "codex-db",
    pid: null,
    parentId: parent ? `codex:${parent}` : null,
    agentType: parent ? (asString(thread.agent_role) ?? asString(thread.agent_nickname)) : null,
  };
}

// thread_spawn_edges names the parent of every subagent thread Codex spawned.
function spawnParents(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db
      .prepare(`SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges`)
      .all() as unknown as Array<{ parent_thread_id: string; child_thread_id: string }>;
    for (const row of rows) {
      out.set(row.child_thread_id, row.parent_thread_id);
    }
  } catch {
    // Older Codex builds have no spawn table; subagents then just lack a parent.
  }
  return out;
}

function lockedThreads(dir: string): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".lock") && !name.startsWith("."))
        .map((name) => name.slice(0, -".lock".length)),
    );
  } catch {
    return new Set();
  }
}

function openReadOnly(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}
