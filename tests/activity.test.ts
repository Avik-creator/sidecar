import { describe, expect, it } from "vitest";
import { activityLabel, formatDuration, formatTokens, shortModel, toolVerb } from "../src/shared/activity.js";
import type { SessionRecord } from "../src/shared/types.js";

const NOW = Date.parse("2026-09-07T12:00:00Z");

function session(partial: Partial<SessionRecord>): SessionRecord {
  return {
    id: "claude:s",
    harness: "claude",
    nativeId: "s",
    cwd: null,
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

describe("activity label", () => {
  it("names the tool in flight and how long the turn has run", () => {
    const row = session({ lastTool: "Bash", lastPromptTs: new Date(NOW - 72_000).toISOString() });
    expect(activityLabel(row, NOW)).toBe("Running command · 1m 12s");
  });

  it("says thinking between tools and drops the timer without a prompt", () => {
    expect(activityLabel(session({ lastTool: null }), NOW)).toBe("Thinking");
    expect(activityLabel(session({ lastTool: "Edit", lastPromptTs: null }), NOW)).toBe("Editing");
  });

  it("puts the person first when the agent is waiting", () => {
    expect(activityLabel(session({ state: "needs_attention", hasBlocking: true, lastTool: "Bash" }), NOW)).toBe("Needs permission");
    expect(activityLabel(session({ state: "needs_attention" }), NOW)).toBe("Your turn");
    expect(activityLabel(session({ state: "ended" }), NOW)).toBe("Done");
    expect(activityLabel(session({ state: "unknown" }), NOW)).toBe("Not reporting");
  });
});

describe("tool verbs", () => {
  it("folds harness tool names into a few verbs", () => {
    expect(toolVerb("Edit")).toBe("Editing");
    expect(toolVerb("apply_patch")).toBe("Editing");
    expect(toolVerb("Read")).toBe("Reading");
    expect(toolVerb("exec")).toBe("Running command");
    expect(toolVerb("Grep")).toBe("Searching");
    expect(toolVerb("Task")).toBe("Delegating");
    expect(toolVerb("WebFetch")).toBe("Browsing");
    expect(toolVerb("mcp__linear-server__get_issue")).toBe("Using linear-server");
    expect(toolVerb("Weird")).toBe("Using Weird");
  });
});

describe("formatting", () => {
  it("formats durations, models, and token counts for a narrow card", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(shortModel("claude-sonnet-4-5-20250929")).toBe("sonnet 4.5");
    expect(shortModel("claude-opus-5")).toBe("opus 5");
    expect(shortModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(shortModel(null)).toBeNull();
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(250_000)).toBe("250k");
    expect(formatTokens(3_200_000)).toBe("3.2M");
  });
});
