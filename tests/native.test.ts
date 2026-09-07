import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/core/db/store.js";
import { readClaudeRegistry } from "../src/core/native/claude.js";
import { readCodexThreads } from "../src/core/native/codex.js";
import { readCursorComposers } from "../src/core/native/cursor.js";
import { applyNativeStates } from "../src/core/native/index.js";
import { liveSessions } from "../src/core/agents/query.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-native-"));
  tmpDirs.push(dir);
  return dir;
}

const NOW = Date.parse("2026-09-07T12:00:00Z");
const alwaysAlive = () => true;
const neverAlive = () => false;

describe("claude session registry", () => {
  function registry(entries: Array<Record<string, unknown>>): string {
    const dir = path.join(tmp(), "sessions");
    fs.mkdirSync(dir, { recursive: true });
    entries.forEach((entry, index) => {
      fs.writeFileSync(path.join(dir, `${entry.pid ?? index}.json`), JSON.stringify(entry));
    });
    fs.writeFileSync(path.join(dir, "1.key"), "not json");
    return dir;
  }

  const base = {
    pid: 4242,
    sessionId: "abc-123",
    cwd: "/repo",
    kind: "interactive",
    name: "Wire live usage",
    startedAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    statusUpdatedAt: NOW - 1_000,
  };

  it("maps Claude's own status words onto Sidecar states", () => {
    const dir = registry([
      { ...base, pid: 1, sessionId: "busy", status: "busy" },
      { ...base, pid: 2, sessionId: "shell", status: "shell" },
      { ...base, pid: 3, sessionId: "waiting", status: "waiting" },
      { ...base, pid: 4, sessionId: "idle", status: "idle" },
    ]);
    const byId = new Map(readClaudeRegistry(dir, alwaysAlive).map((row) => [row.nativeId, row]));
    expect(byId.get("busy")).toMatchObject({ state: "active", hasBlocking: false, eventType: "registry:busy" });
    expect(byId.get("shell")).toMatchObject({ state: "active", hasBlocking: false });
    expect(byId.get("waiting")).toMatchObject({ state: "needs_attention", hasBlocking: true });
    expect(byId.get("idle")).toMatchObject({ state: "needs_attention", hasBlocking: false });
    expect(byId.get("busy")).toMatchObject({
      pid: 1,
      cwd: "/repo",
      title: "Wire live usage",
      source: "claude-registry",
      ts: new Date(NOW - 1_000).toISOString(),
    });
  });

  it("reads a file whose process is gone as ended", () => {
    const dir = registry([{ ...base, status: "busy" }]);
    expect(readClaudeRegistry(dir, neverAlive)[0]).toMatchObject({ state: "ended", eventType: "registry:gone" });
  });

  it("skips daemons, unknown statuses, and files it cannot read", () => {
    const dir = registry([
      { ...base, pid: 1, sessionId: "d", kind: "daemon", status: "busy" },
      { ...base, pid: 2, sessionId: "w", kind: "daemon-worker", status: "busy" },
      { ...base, pid: 3, sessionId: "odd", status: "dancing" },
      { pid: 4, status: "busy" },
    ]);
    fs.writeFileSync(path.join(dir, "9.json"), "{not json");
    expect(readClaudeRegistry(dir, alwaysAlive)).toEqual([]);
    expect(readClaudeRegistry(path.join(dir, "missing"), alwaysAlive)).toEqual([]);
  });
});

describe("codex thread tables", () => {
  function codexHome(): string {
    const root = tmp();
    const state = new DatabaseSync(path.join(root, "state_5.sqlite"));
    state.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, name TEXT,
        agent_role TEXT, agent_nickname TEXT, archived INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, updated_at_ms INTEGER
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL
      );
    `);
    state.close();
    const history = new DatabaseSync(path.join(root, "thread_history_1.sqlite"));
    history.exec(`
      CREATE TABLE thread_turns (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
        status TEXT NOT NULL, started_at INTEGER, completed_at INTEGER, PRIMARY KEY (thread_id, turn_id)
      );
    `);
    history.close();
    fs.mkdirSync(path.join(root, "thread-writer-locks"), { recursive: true });
    fs.writeFileSync(path.join(root, "thread-writer-locks", ".coordination.lock"), "");
    return root;
  }

  function thread(root: string, id: string, extra: Partial<Record<string, unknown>> = {}): void {
    const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
    db.prepare(
      `INSERT INTO threads(id, cwd, title, name, agent_role, agent_nickname, archived, updated_at, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      (extra.cwd as string) ?? "/repo",
      (extra.title as string) ?? "Fix the thing",
      (extra.name as string) ?? null,
      (extra.agent_role as string) ?? null,
      (extra.agent_nickname as string) ?? null,
      (extra.archived as number) ?? 0,
      Math.floor(((extra.updated_at_ms as number) ?? NOW - 5_000) / 1000),
      (extra.updated_at_ms as number) ?? NOW - 5_000,
    );
    db.close();
  }

  function turn(root: string, threadId: string, ordinal: number, status: string, started: number, completed: number | null): void {
    const db = new DatabaseSync(path.join(root, "thread_history_1.sqlite"));
    db.prepare(
      `INSERT INTO thread_turns(thread_id, turn_id, rollout_ordinal, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(threadId, `${threadId}-${ordinal}`, ordinal, status, Math.floor(started / 1000), completed ? Math.floor(completed / 1000) : null);
    db.close();
  }

  function lock(root: string, threadId: string): void {
    fs.writeFileSync(path.join(root, "thread-writer-locks", `${threadId}.lock`), "");
  }

  it("reads a locked thread with a turn in progress as working", () => {
    const root = codexHome();
    thread(root, "t1", { name: "Named thread" });
    turn(root, "t1", 1, "completed", NOW - 90_000, NOW - 60_000);
    turn(root, "t1", 2, "inProgress", NOW - 30_000, null);
    lock(root, "t1");
    const [row] = readCodexThreads(root, NOW);
    expect(row).toMatchObject({
      harness: "codex",
      nativeId: "t1",
      state: "active",
      hasBlocking: false,
      eventType: "turn:inProgress",
      title: "Named thread",
      cwd: "/repo",
      source: "codex-db",
      pid: null,
      ts: new Date(Math.floor((NOW - 30_000) / 1000) * 1000).toISOString(),
    });
  });

  it("reads a locked thread between turns as your turn, and an unlocked one as ended", () => {
    const root = codexHome();
    thread(root, "open");
    turn(root, "open", 1, "completed", NOW - 90_000, NOW - 60_000);
    lock(root, "open");
    thread(root, "fresh");
    lock(root, "fresh");
    thread(root, "closed");
    turn(root, "closed", 1, "inProgress", NOW - 30_000, null);
    const byId = new Map(readCodexThreads(root, NOW).map((row) => [row.nativeId, row]));
    expect(byId.get("open")).toMatchObject({ state: "needs_attention", hasBlocking: false, eventType: "turn:completed" });
    expect(byId.get("fresh")).toMatchObject({ state: "needs_attention", eventType: "thread:open" });
    // A stale inProgress row without a lock is a crash leftover, not a running agent.
    expect(byId.get("closed")).toMatchObject({ state: "ended", eventType: "thread:closed" });
  });

  it("links spawned subagent threads to their parent", () => {
    const root = codexHome();
    thread(root, "parent");
    thread(root, "child", { agent_role: "explorer", agent_nickname: "Scout" });
    const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
    db.exec(`INSERT INTO thread_spawn_edges VALUES ('parent', 'child', 'running')`);
    db.close();
    const byId = new Map(readCodexThreads(root, NOW).map((row) => [row.nativeId, row]));
    expect(byId.get("child")).toMatchObject({ parentId: "codex:parent", agentType: "explorer" });
    expect(byId.get("parent")).toMatchObject({ parentId: null, agentType: null });
  });

  it("ignores archived and week-old threads and a missing home", () => {
    const root = codexHome();
    thread(root, "archived", { archived: 1 });
    thread(root, "old", { updated_at_ms: NOW - 8 * 24 * 60 * 60 * 1000 });
    expect(readCodexThreads(root, NOW)).toEqual([]);
    expect(readCodexThreads(path.join(root, "nope"), NOW)).toEqual([]);
  });
});

describe("cursor composer records", () => {
  function cursorDb(): string {
    const file = path.join(tmp(), "state.vscdb");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER,
        isSubagent INTEGER, recency INTEGER, value TEXT
      );
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    `);
    db.close();
    return file;
  }

  function composer(file: string, id: string, data: Record<string, unknown>, header: Record<string, unknown> = {}): void {
    const db = new DatabaseSync(file);
    const recency = (header.recency as number) ?? NOW - 2_000;
    db.prepare(`INSERT INTO composerHeaders VALUES (?, ?, ?, 0, 0, ?, ?)`).run(
      id,
      NOW - 60_000,
      recency,
      recency,
      JSON.stringify({
        workspaceIdentifier: { uri: { fsPath: "/repo" } },
        name: "Header name",
        ...header,
      }),
    );
    db.prepare(`INSERT INTO cursorDiskKV VALUES (?, ?)`).run(`composerData:${id}`, JSON.stringify(data));
    db.close();
  }

  it("maps generating, unread, and finished conversations", () => {
    const file = cursorDb();
    composer(file, "gen", { status: "none", generatingBubbleIds: ["b1"], hasUnreadMessages: false, name: "Generating" });
    composer(file, "reading", { status: "none", generatingBubbleIds: [], isReadingLongFile: true });
    composer(file, "unread", { status: "completed", generatingBubbleIds: [], hasUnreadMessages: true });
    composer(file, "done", { status: "completed", generatingBubbleIds: [], hasUnreadMessages: false });
    composer(file, "aborted", { status: "aborted", generatingBubbleIds: [] });
    composer(file, "never", { status: "none", generatingBubbleIds: [] });
    const byId = new Map(readCursorComposers(file, 777, true, NOW).map((row) => [row.nativeId, row]));
    expect(byId.get("gen")).toMatchObject({
      state: "active",
      eventType: "composer:generating",
      title: "Generating",
      cwd: "/repo",
      pid: 777,
      source: "cursor-db",
    });
    expect(byId.get("reading")).toMatchObject({ state: "active" });
    expect(byId.get("unread")).toMatchObject({ state: "needs_attention", hasBlocking: false, eventType: "composer:unread" });
    expect(byId.get("done")).toMatchObject({ state: "ended", eventType: "composer:completed", title: "Header name" });
    expect(byId.get("aborted")).toMatchObject({ state: "ended" });
    expect(byId.has("never")).toBe(false);
  });

  it("ends everything when Cursor is not running, and claims nothing when that is unknown", () => {
    const file = cursorDb();
    composer(file, "gen", { status: "none", generatingBubbleIds: ["b1"] });
    expect(readCursorComposers(file, null, false, NOW)[0]).toMatchObject({ state: "ended", eventType: "app:closed" });
    expect(readCursorComposers(file, null, null, NOW)[0]).toMatchObject({ state: "active" });
  });

  it("carries the parent of a Cursor subagent and skips old conversations", () => {
    const file = cursorDb();
    composer(
      file,
      "child",
      { status: "none", generatingBubbleIds: ["b"] },
      { subagentInfo: { parentComposerId: "root", subagentTypeName: "explore" } },
    );
    composer(file, "old", { status: "none", generatingBubbleIds: ["b"] }, { recency: NOW - 2 * 24 * 60 * 60 * 1000 });
    const rows = readCursorComposers(file, 1, true, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ parentId: "cursor:root", agentType: "explore" });
    expect(readCursorComposers(path.join(path.dirname(file), "missing.vscdb"), 1, true, NOW)).toEqual([]);
  });
});

describe("native state in the store", () => {
  // Live queries compare against the wall clock, so these timestamps must be real.
  const LIVE = Date.now();
  it("writes registry state, then lets a newer hook event override it and an older one lose", () => {
    const home = tmp();
    const sessions = path.join(home, "sessions");
    fs.mkdirSync(sessions);
    fs.writeFileSync(
      path.join(sessions, "50.json"),
      JSON.stringify({
        pid: 50,
        sessionId: "s1",
        cwd: "/repo",
        kind: "interactive",
        name: "Registry title",
        status: "busy",
        updatedAt: LIVE - 10_000,
        statusUpdatedAt: LIVE - 10_000,
      }),
    );
    const store = Store.open(path.join(home, "db.sqlite"));
    const report = applyNativeStates(store, {
      claudeSessionsDir: sessions,
      codexRoot: path.join(home, "no-codex"),
      cursorDb: path.join(home, "no-cursor.vscdb"),
      alive: alwaysAlive,
      cursorPid: null,
    });
    expect(report).toEqual({ states: 1, errors: [] });

    const [written] = store.listSessions();
    expect(written).toMatchObject({
      id: "claude:s1",
      state: "active",
      stateSource: "claude-registry",
      pid: 50,
      title: "Registry title",
      hookEvent: "registry:busy",
    });
    // No hook has fired, so the harness still reads as never heard from.
    expect(store.lastHookEventAt()).toEqual({});

    store.applyHookState({
      sessionId: "claude:s1",
      harness: "claude",
      nativeId: "s1",
      cwd: "/repo",
      state: "needs_attention",
      hasBlocking: true,
      ts: new Date(LIVE - 5_000).toISOString(),
      eventType: "PermissionRequest",
    });
    expect(store.listSessions()[0]).toMatchObject({ state: "needs_attention", hasBlocking: true, stateSource: "hook", pid: 50 });
    expect(store.lastHookEventAt()).toEqual({ claude: new Date(LIVE - 5_000).toISOString() });

    // The registry read again with its old timestamp must not undo the newer hook.
    applyNativeStates(store, { claudeSessionsDir: sessions, codexRoot: home, cursorDb: home, alive: alwaysAlive, cursorPid: null });
    expect(store.listSessions()[0]).toMatchObject({ state: "needs_attention", stateSource: "hook" });
    expect(store.lastHookEventAt()).toEqual({ claude: new Date(LIVE - 5_000).toISOString() });

    // The live query reads a dead pid as ended regardless of what was written.
    expect(liveSessions(store, alwaysAlive)[0]?.state).toBe("needs_attention");
    expect(liveSessions(store, neverAlive)[0]?.state).toBe("ended");
    store.close();
  });

  it("reports a reader that throws without losing the others", () => {
    const home = tmp();
    const sessions = path.join(home, "sessions");
    fs.mkdirSync(sessions);
    fs.writeFileSync(
      path.join(sessions, "7.json"),
      JSON.stringify({ pid: 7, sessionId: "ok", kind: "interactive", status: "idle", updatedAt: NOW }),
    );
    fs.writeFileSync(path.join(home, "state_5.sqlite"), "definitely not a database");
    const store = Store.open(path.join(home, "db.sqlite"));
    const report = applyNativeStates(store, {
      claudeSessionsDir: sessions,
      codexRoot: home,
      cursorDb: path.join(home, "none.vscdb"),
      alive: alwaysAlive,
      cursorPid: null,
    });
    expect(report.states).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^codex:/);
    expect(store.listSessions()[0]?.id).toBe("claude:ok");
    store.close();
  });
});
