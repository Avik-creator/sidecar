import { describe, expect, it } from "vitest";
import { compareSessions, liveSessions, normalizeSession } from "../src/core/agents/query.js";
import type { Store } from "../src/core/db/store.js";
import type { SessionRecord } from "../src/shared/types.js";

const NOW = Date.parse("2026-08-27T12:00:00Z");

function ago(minutes: number): string {
  return new Date(NOW - minutes * 60 * 1000).toISOString();
}

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, "id" | "state">): SessionRecord {
  return {
    harness: "claude",
    nativeId: partial.id,
    cwd: "/tmp/proj",
    gitBranch: "main",
    worktree: false,
    title: "task",
    startedAt: ago(60),
    endedAt: null,
    lastTs: ago(1),
    hasBlocking: false,
    isSidechain: false,
    hookTs: ago(1),
    hookEvent: "PostToolUse",
    activity: "task",
    lastRole: "assistant",
    ...partial,
  };
}

describe("session state without hooks", () => {
  it("makes no claim about a session that has never reported", () => {
    const next = normalizeSession(
      session({ id: "quiet", state: "active", hookTs: null, hookEvent: null }),
      NOW,
    );
    expect(next.state).toBe("unknown");
    expect(next.hasBlocking).toBe(false);
  });

  it("refuses to promote a stale transcript into a running session", () => {
    const next = normalizeSession(
      session({
        id: "old-transcript",
        state: "needs_attention",
        hasBlocking: true,
        hookTs: null,
        lastTs: ago(0),
      }),
      NOW,
    );
    expect(next.state).toBe("unknown");
    expect(next.hasBlocking).toBe(false);
  });
});

describe("session state from hooks", () => {
  it("keeps a working session while its hooks are recent", () => {
    const next = normalizeSession(
      session({ id: "working", state: "active", hookTs: ago(2), hookEvent: "PostToolUse" }),
      NOW,
    );
    expect(next.state).toBe("active");
  });

  it("ends a working session once its hooks go silent", () => {
    const next = normalizeSession(
      session({ id: "died", state: "active", hookTs: ago(6), hookEvent: "PreToolUse" }),
      NOW,
    );
    expect(next.state).toBe("ended");
  });

  it("holds a finished turn as needing you for hours", () => {
    const next = normalizeSession(
      session({
        id: "your-turn",
        state: "needs_attention",
        hasBlocking: false,
        hookTs: ago(90),
        hookEvent: "Stop",
      }),
      NOW,
    );
    expect(next.state).toBe("needs_attention");
    expect(next.hasBlocking).toBe(false);
  });

  it("lets a finished turn go once it is clearly abandoned", () => {
    const next = normalizeSession(
      session({
        id: "forgotten",
        state: "needs_attention",
        hasBlocking: false,
        hookTs: ago(60 * 5),
        hookEvent: "Stop",
      }),
      NOW,
    );
    expect(next.state).toBe("ended");
  });

  it("expires a permission prompt sooner than a finished turn", () => {
    const fresh = normalizeSession(
      session({
        id: "blocked",
        state: "needs_attention",
        hasBlocking: true,
        hookTs: ago(10),
        hookEvent: "PermissionRequest",
      }),
      NOW,
    );
    expect(fresh).toMatchObject({ state: "needs_attention", hasBlocking: true });

    const stale = normalizeSession(
      session({
        id: "blocked-stale",
        state: "needs_attention",
        hasBlocking: true,
        hookTs: ago(45),
        hookEvent: "PermissionRequest",
      }),
      NOW,
    );
    expect(stale.state).toBe("ended");
    expect(stale.hasBlocking).toBe(false);
  });

  it("respects an explicit session end regardless of age", () => {
    const next = normalizeSession(
      session({ id: "closed", state: "ended", hookTs: ago(1), hookEvent: "SessionEnd" }),
      NOW,
    );
    expect(next.state).toBe("ended");
  });
});

describe("agent ranking", () => {
  it("orders blocked, then your turn, then working, then done, then unreported", () => {
    const rows = [
      session({ id: "unreported", state: "unknown", hookTs: null, lastTs: ago(1) }),
      session({ id: "done", state: "ended", lastTs: ago(2) }),
      session({ id: "working", state: "active", lastTs: ago(3) }),
      session({ id: "your-turn", state: "needs_attention", hasBlocking: false, lastTs: ago(4) }),
      session({ id: "blocked", state: "needs_attention", hasBlocking: true, lastTs: ago(5) }),
    ].sort(compareSessions);
    expect(rows.map((row) => row.id)).toEqual([
      "blocked",
      "your-turn",
      "working",
      "done",
      "unreported",
    ]);
  });

  it("breaks ties by most recent activity", () => {
    const rows = [
      session({ id: "older", state: "active", lastTs: ago(9) }),
      session({ id: "newer", state: "active", lastTs: ago(1) }),
    ].sort(compareSessions);
    expect(rows.map((row) => row.id)).toEqual(["newer", "older"]);
  });

  it("keeps subagent sessions in the live result", () => {
    const child = session({
      id: "subagent",
      state: "active",
      isSidechain: true,
      hookTs: new Date().toISOString(),
      lastTs: new Date().toISOString(),
    });
    const store = { listSessions: () => [child] } as unknown as Store;
    expect(liveSessions(store).map((row) => row.id)).toEqual(["subagent"]);
  });
});
