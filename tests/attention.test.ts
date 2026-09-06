import { describe, expect, it } from "vitest";
import { attentionIds, newlyNeedingYou } from "../src/main/attention.js";
import type { SessionRecord } from "../src/shared/types.js";

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, "id">): SessionRecord {
  return {
    harness: "claude",
    nativeId: partial.id,
    cwd: "/Users/me/repo",
    gitBranch: null,
    worktree: false,
    title: null,
    startedAt: null,
    endedAt: null,
    lastTs: null,
    state: "active",
    hasBlocking: false,
    isSidechain: false,
    parentId: null,
    agentType: null,
    ...partial,
  };
}

describe("attention transitions", () => {
  it("stays silent on the first pass so launching never replays old prompts", () => {
    const sessions = [session({ id: "a", state: "needs_attention" }), session({ id: "b", hasBlocking: true })];
    expect(newlyNeedingYou(null, sessions, 3)).toEqual([]);
    expect(attentionIds(sessions)).toEqual(new Set(["a", "b"]));
  });

  it("fires once per crossing, not on every refresh", () => {
    const before = [session({ id: "a" })];
    const after = [session({ id: "a", state: "needs_attention" })];
    const first = newlyNeedingYou(attentionIds(before), after, 3);
    expect(first.map((item) => item.id)).toEqual(["a"]);
    expect(newlyNeedingYou(attentionIds(after), after, 3)).toEqual([]);
  });

  it("fires again when a session returns to needing you", () => {
    const waiting = [session({ id: "a", state: "needs_attention" })];
    const working = [session({ id: "a", state: "active" })];
    expect(newlyNeedingYou(attentionIds(working), waiting, 3).map((item) => item.id)).toEqual(["a"]);
  });

  it("caps a burst so one batch ingest cannot flood the desktop", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => session({ id, state: "needs_attention" }));
    expect(newlyNeedingYou(new Set(), many, 3)).toHaveLength(3);
  });
});
