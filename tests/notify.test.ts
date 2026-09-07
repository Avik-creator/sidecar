import { describe, expect, it } from "vitest";
import { inQuietHours } from "../src/core/notify/quiet.js";
import { quotaAlerts } from "../src/core/usage/alerts.js";
import type { LiveUsageSnapshot } from "../src/shared/types.js";

function at(hours: number, minutes = 0): Date {
  const date = new Date(2026, 8, 7, hours, minutes);
  return date;
}

describe("quiet hours", () => {
  it("holds notifications inside a same-day range and outside it lets them through", () => {
    expect(inQuietHours(at(13), "12:00", "14:00")).toBe(true);
    expect(inQuietHours(at(14), "12:00", "14:00")).toBe(false);
    expect(inQuietHours(at(11, 59), "12:00", "14:00")).toBe(false);
  });

  it("wraps a range that crosses midnight", () => {
    expect(inQuietHours(at(23), "22:00", "07:00")).toBe(true);
    expect(inQuietHours(at(3), "22:00", "07:00")).toBe(true);
    expect(inQuietHours(at(7), "22:00", "07:00")).toBe(false);
    expect(inQuietHours(at(12), "22:00", "07:00")).toBe(false);
  });

  it("is never quiet without a complete, distinct range", () => {
    expect(inQuietHours(at(23), null, "07:00")).toBe(false);
    expect(inQuietHours(at(23), "22:00", null)).toBe(false);
    expect(inQuietHours(at(23), "22:00", "22:00")).toBe(false);
    expect(inQuietHours(at(23), "nope", "07:00")).toBe(false);
  });
});

describe("quota alerts", () => {
  const NOW = Date.parse("2026-09-07T12:00:00Z");
  const snapshot = (provider: LiveUsageSnapshot["provider"], used: number, resetsAt: string | null): LiveUsageSnapshot => ({
    provider,
    plan: "Max",
    status: "ok",
    fetchedAt: null,
    error: null,
    windows: [{ label: "Session", used, limit: 100, unit: "percent", resetsAt }],
    details: [],
  });

  it("fires once per window per reset when the threshold is crossed", () => {
    const seen = new Set<string>();
    const reset = "2026-09-07T13:30:00Z";
    expect(quotaAlerts([snapshot("claude", 89, reset)], 90, seen, NOW)).toEqual([]);
    const first = quotaAlerts([snapshot("claude", 92, reset)], 90, seen, NOW);
    expect(first).toEqual([
      { key: `claude:Session:${reset}`, title: "Claude Code session window at 92%", body: "8% left, resets in 2h." },
    ]);
    expect(quotaAlerts([snapshot("claude", 95, reset)], 90, seen, NOW)).toEqual([]);
    // The next window is a fresh alert.
    expect(quotaAlerts([snapshot("claude", 95, "2026-09-07T18:30:00Z")], 90, seen, NOW)).toHaveLength(1);
  });

  it("stays silent when turned off or when the window has no limit", () => {
    const seen = new Set<string>();
    expect(quotaAlerts([snapshot("codex", 99, null)], 0, seen, NOW)).toEqual([]);
    const unlimited = snapshot("codex", 99, null);
    unlimited.windows[0]!.limit = 0;
    expect(quotaAlerts([unlimited], 50, seen, NOW)).toEqual([]);
    expect(quotaAlerts([snapshot("codex", 99, null)], 50, seen, NOW)[0]?.body).toBe("1% left.");
  });
});
