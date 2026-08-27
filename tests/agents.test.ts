import { describe, expect, it } from "vitest";
import { compareSessions, liveSessions, normalizeSession } from "../src/core/agents/query.js";
import type { Store } from "../src/core/db/store.js";
import type { SessionRecord } from "../src/shared/types.js";

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, "id" | "state">): SessionRecord {
  return {
    harness: "claude",
    nativeId: partial.id,
    cwd: "/tmp/proj",
    gitBranch: "main",
    worktree: false,
    title: "task",
    startedAt: "2026-08-27T00:00:00Z",
    endedAt: null,
    lastTs: "2026-08-27T00:00:00Z",
    hasBlocking: false,
    isSidechain: false,
    activity: "task",
    lastRole: "assistant",
    ...partial,
  };
}

describe("agent ranking", () => {
  it("puts blocking sessions first, then active, then ended", () => {
    const rows = [
      session({ id: "ended", state: "ended", lastTs: "2026-08-27T03:00:00Z" }),
      session({ id: "active", state: "active", lastTs: "2026-08-27T04:00:00Z" }),
      session({ id: "block", state: "needs_attention", hasBlocking: true, lastTs: "2026-08-27T01:00:00Z" }),
    ].sort(compareSessions);
    expect(rows.map((row) => row.id)).toEqual(["block", "active", "ended"]);
  });

  it("marks stale active sessions as ended", () => {
    const now = Date.parse("2026-08-27T12:00:00Z");
    const next = normalizeSession(
      session({ id: "old", state: "active", lastTs: "2026-08-27T10:00:00Z" }),
      now,
    );
    expect(next.state).toBe("ended");
  });

  it("treats recently updated unknown sessions as active", () => {
    const now = Date.parse("2026-08-27T12:00:00Z");
    const next = normalizeSession(
      session({ id: "recent", state: "unknown", lastTs: "2026-08-27T11:58:00Z" }),
      now,
    );
    expect(next.state).toBe("active");
  });

  it("does not keep stale blocking sessions in needs-attention", () => {
    const now = Date.parse("2026-08-27T12:00:00Z");
    const next = normalizeSession(
      session({
        id: "stale-block",
        state: "needs_attention",
        hasBlocking: true,
        lastTs: "2026-08-27T10:00:00Z",
      }),
      now,
    );
    expect(next.state).toBe("ended");
    expect(next.hasBlocking).toBe(false);
  });

  it("keeps subagent sessions in the live result", () => {
    const child = session({
      id: "subagent",
      state: "active",
      isSidechain: true,
      lastTs: new Date().toISOString(),
    });
    const store = { listSessions: () => [child] } as Store;
    expect(liveSessions(store)).toEqual([child]);
  });
});
