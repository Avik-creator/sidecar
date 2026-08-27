import { describe, expect, it } from "vitest";
import { prefilterTurns } from "../src/core/improve/prefilter.js";
import type { TurnRecord } from "../src/shared/types.js";

function turn(partial: Partial<TurnRecord> & Pick<TurnRecord, "id" | "role" | "text" | "ts">): TurnRecord {
  return {
    sessionId: "claude:s1",
    sourceEventId: partial.id,
    model: null,
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
    isUserPrompt: partial.role === "user",
    ...partial,
  };
}

describe("prefilter", () => {
  it("ignores tool-result rows and quoted code negatives", () => {
    const hits = prefilterTurns([
      turn({
        id: "1",
        role: "user",
        ts: "2026-01-01T00:00:00Z",
        text: "please implement auth",
        isUserPrompt: true,
      }),
      turn({
        id: "2",
        role: "assistant",
        ts: "2026-01-01T00:00:01Z",
        text: "ok",
      }),
      turn({
        id: "3",
        role: "user",
        ts: "2026-01-01T00:00:02Z",
        text: "const msg = \"that's wrong\"",
        isUserPrompt: false,
      }),
      turn({
        id: "synth",
        role: "user",
        ts: "2026-01-01T00:00:03Z",
        text: "This session is being continued from a previous conversation that ran out of context. actually don't.",
        isUserPrompt: true,
      }),
      turn({
        id: "4",
        role: "user",
        ts: "2026-01-01T00:00:04Z",
        text: "No, don't write tests in that folder. I told you to use tests/unit.",
        isUserPrompt: true,
      }),
    ]);
    expect(hits.map((h) => h.turn.id)).toEqual(["4"]);
    expect(hits[0]?.signals).toEqual(expect.arrayContaining(["no_dont", "i_told_you"]));
  });

  it("does not treat fenced code as a correction", () => {
    const hits = prefilterTurns([
      turn({
        id: "u",
        role: "user",
        ts: "2026-01-01T00:00:00Z",
        text: "here is the snippet\n```\nthrow new Error(\"that's wrong\")\n```\nkeep going",
        isUserPrompt: true,
      }),
    ]);
    expect(hits).toHaveLength(0);
  });

  it("ignores lexical hits buried in a long paste", () => {
    const hits = prefilterTurns([
      turn({
        id: "paste",
        role: "user",
        ts: "2026-01-01T00:00:00Z",
        text: `${"lorem ipsum ".repeat(500)}\nNo, don't do that again. I told you that's wrong.`,
        isUserPrompt: true,
      }),
    ]);
    expect(hits).toHaveLength(0);
  });
});
