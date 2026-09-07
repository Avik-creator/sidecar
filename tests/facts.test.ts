import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { withUsage } from "../src/core/agents/query.js";
import { Store } from "../src/core/db/store.js";
import { lastToolFromEvent } from "../src/core/hooks/events.js";
import { foldSessions, parseClaudeLine } from "../src/core/ingest/claude.js";
import { parseCodexLine } from "../src/core/ingest/codex.js";
import { readCodexThreads } from "../src/core/native/codex.js";
import { readCursorComposers } from "../src/core/native/cursor.js";
import type { SessionRecord } from "../src/shared/types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-facts-"));
  tmpDirs.push(dir);
  return dir;
}

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, "id">): SessionRecord {
  return {
    harness: "claude",
    nativeId: partial.id,
    cwd: null,
    gitBranch: null,
    worktree: false,
    title: null,
    startedAt: null,
    endedAt: null,
    lastTs: null,
    state: "unknown",
    hasBlocking: false,
    isSidechain: false,
    parentId: null,
    agentType: null,
    ...partial,
  };
}

function parse(parser: () => ReturnType<typeof parseClaudeLine>) {
  const result = parser();
  if (result === "skip" || result === "fail") {
    throw new Error(`expected a batch, got ${result}`);
  }
  return result;
}

describe("tool in flight from transcripts", () => {
  it("starts on a Claude tool_use block and ends on the result line", () => {
    const call = parse(() =>
      parseClaudeLine(
        "/p/abc.jsonl",
        JSON.stringify({
          type: "assistant",
          sessionId: "abc",
          uuid: "u1",
          timestamp: "2026-09-07T12:00:00Z",
          message: { content: [{ type: "text", text: "Let me look" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        }),
      ),
    );
    const result = parse(() =>
      parseClaudeLine(
        "/p/abc.jsonl",
        JSON.stringify({
          type: "user",
          sessionId: "abc",
          uuid: "u2",
          timestamp: "2026-09-07T12:00:01Z",
          toolUseResult: { ok: true },
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        }),
      ),
    );
    const thinking = parse(() =>
      parseClaudeLine(
        "/p/abc.jsonl",
        JSON.stringify({ type: "assistant", sessionId: "abc", uuid: "u3", timestamp: "2026-09-07T12:00:02Z", message: { content: [{ type: "thinking", thinking: "hm" }] } }),
      ),
    );
    expect(call.sessions[0]?.lastTool).toBe("Bash");
    expect(result.sessions[0]?.lastTool).toBeNull();
    expect(thinking.sessions[0]?.lastTool).toBeUndefined();
    // Folding keeps the newest claim and lets a silent line keep the previous one.
    expect(foldSessions([...call.sessions, ...thinking.sessions])[0]?.lastTool).toBe("Bash");
    expect(foldSessions([...call.sessions, ...result.sessions, ...thinking.sessions])[0]?.lastTool).toBeNull();
  });

  it("starts on a Codex tool call item and ends on its output", () => {
    const file = "/tmp/rollout-019eff07-2885-7572-80c3-e199ebc7013d.jsonl";
    const call = parse(() =>
      parseCodexLine(file, JSON.stringify({ type: "response_item", timestamp: "2026-09-07T12:00:00Z", payload: { type: "custom_tool_call", id: "c1", name: "exec", input: "ls" } })),
    );
    const output = parse(() =>
      parseCodexLine(file, JSON.stringify({ type: "response_item", timestamp: "2026-09-07T12:00:01Z", payload: { type: "custom_tool_call_output", id: "o1", call_id: "c1", output: "x" } })),
    );
    const shell = parse(() =>
      parseCodexLine(file, JSON.stringify({ type: "response_item", timestamp: "2026-09-07T12:00:02Z", payload: { type: "local_shell_call", id: "c2" } })),
    );
    expect(call.sessions[0]?.lastTool).toBe("exec");
    expect(output.sessions[0]?.lastTool).toBeNull();
    expect(shell.sessions[0]?.lastTool).toBe("shell");
  });

  it("reads hook events the same way", () => {
    expect(lastToolFromEvent("PreToolUse", { tool_name: "Edit" })).toBe("Edit");
    expect(lastToolFromEvent("PostToolUse", { tool_name: "Edit" })).toBeNull();
    expect(lastToolFromEvent("preToolUse", { tool: "shell" })).toBe("shell");
    expect(lastToolFromEvent("Stop", {})).toBeNull();
    expect(lastToolFromEvent("SessionStart", {})).toBeUndefined();
  });
});

describe("facts in the store", () => {
  it("keeps last_tool unless a writer makes a claim, and derives the turn start and model", () => {
    const store = Store.open(path.join(tmp(), "db.sqlite"));
    store.upsertSession(session({ id: "claude:s", lastTool: "Bash" }));
    store.upsertSession(session({ id: "claude:s" }));
    expect(store.listSessions()[0]?.lastTool).toBe("Bash");
    store.upsertSession(session({ id: "claude:s", lastTool: null }));
    expect(store.listSessions()[0]?.lastTool).toBeNull();

    store.applyState({
      sessionId: "claude:s",
      harness: "claude",
      nativeId: "s",
      cwd: null,
      title: null,
      state: "active",
      hasBlocking: false,
      ts: "2026-09-07T12:00:05Z",
      eventType: "PreToolUse",
      source: "hook",
      pid: null,
      lastTool: "Read",
      facts: { tasksDone: 2, tasksTotal: 5, queued: 1 },
    });
    store.applyState({
      sessionId: "claude:s",
      harness: "claude",
      nativeId: "s",
      cwd: null,
      title: null,
      state: "active",
      hasBlocking: false,
      ts: "2026-09-07T12:00:06Z",
      eventType: "registry:busy",
      source: "claude-registry",
      pid: 1,
    });
    const turn = (id: string, role: "user" | "assistant", ts: string, model: string | null, isUserPrompt: boolean) => ({
      id,
      sessionId: "claude:s",
      sourceEventId: id,
      role,
      ts,
      model,
      text: "x",
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      stopReason: null,
      permissionMode: null,
      preventedContinuation: false,
      isSidechain: false,
      interrupted: false,
      cursorRulesJson: null,
      parentId: null,
      isUserPrompt,
    });
    store.insertTurn(turn("t1", "user", "2026-09-07T11:59:00Z", null, true));
    store.insertTurn(turn("t2", "assistant", "2026-09-07T11:59:30Z", "claude-opus-5", false));
    store.insertTurn(turn("t3", "user", "2026-09-07T11:59:40Z", null, false));

    const [row] = store.listSessions();
    // A native reader that says nothing about tools leaves the hook's claim in place.
    expect(row).toMatchObject({
      lastTool: "Read",
      tasksDone: 2,
      tasksTotal: 5,
      queued: 1,
      linesAdded: null,
      lastPromptTs: "2026-09-07T11:59:00Z",
      model: "claude-opus-5",
    });
    store.close();
  });

  it("sums tokens and spend per session and rolls subagents into their parent", () => {
    const store = Store.open(path.join(tmp(), "db.sqlite"));
    const event = (id: string, sessionId: string, tokensIn: number, tokensOut: number, model: string) => ({
      sessionId,
      turnId: null,
      sourceEventId: id,
      harness: "claude" as const,
      ts: "2026-09-07T12:00:00Z",
      model,
      tokensIn,
      tokensOut,
      cacheRead: 0,
      cacheWrite: 0,
    });
    store.insertUsage(event("e1", "claude:p", 1_000, 100, "claude-opus-5"));
    store.insertUsage(event("e2", "claude:p", 500, 50, "claude-opus-5"));
    store.insertUsage(event("e3", "claude:p:sub", 2_000, 200, "claude-haiku-4-5-20251001"));
    const usage = store.sessionUsage();
    expect(usage.get("claude:p")?.tokens).toBe(1_650);
    expect(usage.get("claude:p:sub")?.tokens).toBe(2_200);
    expect(usage.get("claude:p")?.usd).toBeGreaterThan(0);

    const rows = withUsage(
      [session({ id: "claude:p" }), session({ id: "claude:p:sub", parentId: "claude:p" }), session({ id: "claude:quiet" })],
      usage,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("claude:p")?.tokens).toBe(3_850);
    expect(byId.get("claude:p")?.usd).toBeCloseTo((usage.get("claude:p")?.usd ?? 0) + (usage.get("claude:p:sub")?.usd ?? 0));
    expect(byId.get("claude:p:sub")?.tokens).toBe(2_200);
    expect(byId.get("claude:quiet")).toMatchObject({ tokens: 0, usd: 0 });
    store.close();
  });
});

describe("facts from native readers", () => {
  it("counts Cursor todos, queue, and diff lines", () => {
    const file = path.join(tmp(), "state.vscdb");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    `);
    const now = Date.now();
    db.prepare(`INSERT INTO composerHeaders VALUES ('c1', ?, ?, 0, 0, ?, '{}')`).run(now - 1000, now, now);
    db.prepare(`INSERT INTO cursorDiskKV VALUES ('composerData:c1', ?)`).run(
      JSON.stringify({
        status: "none",
        generatingBubbleIds: ["b"],
        todos: [{ status: "completed" }, { status: "completed" }, { status: "pending" }],
        queueItems: [{}],
        totalLinesAdded: 97,
        totalLinesRemoved: 511,
      }),
    );
    db.close();
    expect(readCursorComposers(file, 1, true, now)[0]?.facts).toEqual({
      tasksDone: 2,
      tasksTotal: 3,
      queued: 1,
      linesAdded: 97,
      linesRemoved: 511,
    });
  });

  it("counts messages Codex has queued behind the running turn", () => {
    const root = tmp();
    const state = new DatabaseSync(path.join(root, "state_5.sqlite"));
    state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, archived INTEGER DEFAULT 0, updated_at INTEGER, updated_at_ms INTEGER)`);
    const now = Date.now();
    state.prepare(`INSERT INTO threads VALUES ('t1', '/repo', 'Fix', 0, ?, ?)`).run(Math.floor(now / 1000), now);
    state.prepare(`INSERT INTO threads VALUES ('t2', '/repo', 'Other', 0, ?, ?)`).run(Math.floor(now / 1000), now);
    state.close();
    const queue = new DatabaseSync(path.join(root, "queue_1.sqlite"));
    queue.exec(`CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)`);
    queue.exec(`INSERT INTO queued_items VALUES ('q1', 't1', '{}', 0, 0, 0), ('q2', 't1', '{}', 1, 0, 0)`);
    queue.close();
    const byId = new Map(readCodexThreads(root, now).map((row) => [row.nativeId, row]));
    expect(byId.get("t1")?.facts).toEqual({ queued: 2 });
    expect(byId.get("t2")?.facts).toEqual({ queued: 0 });
  });
});
