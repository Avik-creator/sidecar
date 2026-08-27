import { describe, expect, it } from "vitest";
import { MARK_PETAL_COUNT, markCircles, markSvgInner } from "../src/shared/mark.js";

describe("sidecar mark", () => {
  it("draws five outline petals and a small center", () => {
    const circles = markCircles();
    expect(circles).toHaveLength(MARK_PETAL_COUNT + 1);
    expect(markSvgInner()).toContain("fill=\"none\"");
    expect(markSvgInner().match(/<circle /g)).toHaveLength(MARK_PETAL_COUNT + 1);
  });
});
