import { describe, expect, it } from "vitest";
import { foldSessions, isClaudeUserPrompt, parseClaudeLine } from "../src/core/ingest/claude.js";
import { parseCodexLine } from "../src/core/ingest/codex.js";
import type { SessionRecord } from "../src/shared/types.js";

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

describe("claude parser", () => {
  it("indexes assistant usage and ignores tool-result user rows as prompts", () => {
    const assistant = parseClaudeLine(
      "/tmp/abc.jsonl",
      JSON.stringify({
        type: "assistant",
        sessionId: "abc",
        uuid: "u1",
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: "/tmp/proj",
        gitBranch: "main",
        message: {
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "hello" }],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 8,
          },
        },
      }),
    );
    expect(assistant).not.toBe("fail");
    expect(assistant).not.toBe("skip");
    if (assistant === "fail" || assistant === "skip") {
      return;
    }
    expect(assistant.usage[0]?.tokensIn).toBe(10);
    expect(assistant.turns[0]?.model).toBe("claude-sonnet-4");
    // Transcripts carry content only; state comes from hooks.
    expect(assistant.sessions[0]?.state).toBe("unknown");
    expect(assistant.sessions[0]?.hasBlocking).toBe(false);
    expect(assistant.sessions[0]?.cwd).toBe("/tmp/proj");
    expect(assistant.sessions[0]?.gitBranch).toBe("main");

    const completed = parseClaudeLine(
      "/tmp/abc.jsonl",
      JSON.stringify({
        type: "assistant",
        sessionId: "abc",
        uuid: "u2",
        timestamp: "2026-08-01T00:01:00.000Z",
        message: { stop_reason: "end_turn", content: "done" },
      }),
    );
    expect(completed).not.toBe("fail");
    expect(completed).not.toBe("skip");
    if (completed !== "fail" && completed !== "skip") {
      // stop_reason no longer decides anything: end_turn is a hook's job to report.
      expect(completed.sessions[0]?.state).toBe("unknown");
      expect(completed.sessions[0]?.endedAt).toBeNull();
    }

    expect(
      isClaudeUserPrompt({
        type: "user",
        toolUseResult: { ok: true },
        message: { content: "ignored" },
      }),
    ).toBe(false);
    expect(
      isClaudeUserPrompt({
        type: "user",
        message: { role: "user", content: "actually don't do that" },
      }),
    ).toBe(true);

    const permissionMode = parseClaudeLine(
      "/tmp/abc.jsonl",
      JSON.stringify({
        type: "permission-mode",
        sessionId: "abc",
        timestamp: "2026-08-01T00:02:00.000Z",
        permissionMode: "ask",
      }),
    );
    if (permissionMode === "fail" || permissionMode === "skip") {
      throw new Error("expected permission mode to parse");
    }
    expect(permissionMode.sessions[0]?.state).toBe("unknown");
    expect(permissionMode.sessions[0]?.hasBlocking).toBe(false);
  });
});

describe("codex parser", () => {
  it("uses last_token_usage, not cumulative totals", () => {
    const parsed = parseCodexLine(
      "/tmp/rollout-019eff07-2885-7572-80c3-e199ebc7013d.jsonl",
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-25T13:45:52.506Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 99999, output_tokens: 999, cached_input_tokens: 1 },
            last_token_usage: {
              input_tokens: 15,
              output_tokens: 4,
              reasoning_output_tokens: 2,
              cached_input_tokens: 8,
              cache_write_input_tokens: 3,
            },
          },
        },
      }),
    );
    expect(parsed).not.toBe("fail");
    expect(parsed).not.toBe("skip");
    if (parsed === "fail" || parsed === "skip") {
      return;
    }
    expect(parsed.usage[0]?.tokensIn).toBe(15);
    expect(parsed.usage[0]?.tokensOut).toBe(6);
    expect(parsed.usage[0]?.cacheRead).toBe(8);
    expect(parsed.usage[0]?.cacheWrite).toBe(3);
    expect(parsed.sessions[0]?.state).toBe("unknown");
  });

  it("never infers live state from lifecycle events", () => {
    const started = parseCodexLine(
      "/tmp/rollout-019eff07-2885-7572-80c3-e199ebc7013d.jsonl",
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-25T13:45:52.506Z",
        payload: { type: "task_started" },
      }),
    );
    const completed = parseCodexLine(
      "/tmp/rollout-019eff07-2885-7572-80c3-e199ebc7013d.jsonl",
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-25T13:46:52.506Z",
        payload: { type: "task_complete" },
      }),
    );
    if (started === "fail" || started === "skip" || completed === "fail" || completed === "skip") {
      throw new Error("expected lifecycle events to parse");
    }
    expect(started.sessions[0]?.state).toBe("unknown");
    expect(completed.sessions[0]?.state).toBe("unknown");
    expect(completed.sessions[0]?.endedAt).toBeNull();
  });
});

// The fold replaces one upsert per transcript line, so it has to land what the SQL would have.
describe("session folding", () => {
  it("keeps one row per session and mirrors the conflict clause", () => {
    const folded = foldSessions([
      session({ id: "a", cwd: "/repo", startedAt: "2026-01-01T00:00:00Z", lastTs: "2026-01-01T00:00:00Z" }),
      session({ id: "b", title: "other" }),
      session({ id: "a", cwd: null, title: "later", startedAt: "2026-01-02T00:00:00Z", lastTs: "2026-01-01T05:00:00Z" }),
      session({ id: "a", lastTs: "2026-01-01T02:00:00Z", endedAt: "2026-01-01T06:00:00Z" }),
    ]);
    expect(folded).toHaveLength(2);
    const a = folded.find((row) => row.id === "a");
    expect(a?.cwd).toBe("/repo");
    expect(a?.title).toBe("later");
    expect(a?.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(a?.endedAt).toBe("2026-01-01T06:00:00Z");
    expect(a?.lastTs).toBe("2026-01-01T05:00:00Z");
  });

  it("passes distinct sessions through untouched", () => {
    const rows = [session({ id: "a" }), session({ id: "b" })];
    expect(foldSessions(rows)).toEqual(rows);
    expect(foldSessions([])).toEqual([]);
  });
});

describe("claude subagents", () => {
  const SUBAGENT_FILE = "/p/-proj/abc-123/subagents/agent-a27b1d52.jsonl";

  function parse(file: string, record: Record<string, unknown>) {
    const result = parseClaudeLine(file, JSON.stringify(record));
    if (result === "skip" || result === "fail") {
      throw new Error(`expected a batch, got ${result}`);
    }
    return result;
  }

  it("gives a subagent its own session keyed under the parent", () => {
    // A subagent transcript carries the parent's sessionId, so only agentId separates them.
    const batch = parse(SUBAGENT_FILE, {
      type: "assistant",
      sessionId: "abc-123",
      agentId: "a27b1d52",
      isSidechain: true,
      attributionAgent: "Explore",
      cwd: "/repo",
      timestamp: "2026-08-07T12:12:43.911Z",
      uuid: "u1",
      message: { role: "assistant", content: "looking" },
    });

    expect(batch.sessions[0]?.id).toBe("claude:abc-123:a27b1d52");
    expect(batch.sessions[0]?.parentId).toBe("claude:abc-123");
    expect(batch.sessions[0]?.agentType).toBe("Explore");
    expect(batch.sessions[0]?.isSidechain).toBe(true);
    expect(batch.turns[0]?.sessionId).toBe("claude:abc-123:a27b1d52");
  });

  it("leaves the parent transcript on the parent row", () => {
    const batch = parse("/p/-proj/abc-123.jsonl", {
      type: "assistant",
      sessionId: "abc-123",
      isSidechain: false,
      cwd: "/repo",
      timestamp: "2026-08-07T12:00:00.000Z",
      uuid: "u2",
      message: { role: "assistant", content: "planning" },
    });

    expect(batch.sessions[0]?.id).toBe("claude:abc-123");
    expect(batch.sessions[0]?.parentId).toBeNull();
    expect(batch.sessions[0]?.isSidechain).toBe(false);
  });

  it("keeps the agent type when a later line omits it", () => {
    // Only some subagent lines carry attributionAgent, and they are not the last ones.
    const named = parse(SUBAGENT_FILE, {
      type: "assistant",
      sessionId: "abc-123",
      agentId: "a27b1d52",
      attributionAgent: "Explore",
      timestamp: "2026-08-07T12:12:43.911Z",
      uuid: "u3",
      message: { role: "assistant", content: "one" },
    });
    const unnamed = parse(SUBAGENT_FILE, {
      type: "user",
      sessionId: "abc-123",
      agentId: "a27b1d52",
      timestamp: "2026-08-07T12:12:44.000Z",
      uuid: "u4",
      message: { role: "user", content: "two" },
    });

    const folded = foldSessions([...named.sessions, ...unnamed.sessions]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.agentType).toBe("Explore");
    expect(folded[0]?.parentId).toBe("claude:abc-123");
  });

  it("falls back to the directory when a subagent line omits its sessionId", () => {
    const batch = parse(SUBAGENT_FILE, {
      type: "assistant",
      agentId: "a27b1d52",
      timestamp: "2026-08-07T12:12:43.911Z",
      uuid: "u5",
      message: { role: "assistant", content: "three" },
    });

    expect(batch.sessions[0]?.parentId).toBe("claude:abc-123");
  });
});
