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

describe("tray mark", () => {
  it("renders a distinct solid variant for when agents are working", async () => {
    const { trayMarkPng } = await import("../src/main/raster.js");
    const outline = trayMarkPng(32, false);
    const filled = trayMarkPng(32, true);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(outline.subarray(0, 4)).toEqual(signature);
    expect(filled.subarray(0, 4)).toEqual(signature);
    expect(filled.equals(outline)).toBe(false);
  });
});
