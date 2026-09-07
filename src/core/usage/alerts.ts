import type { LiveUsageSnapshot, UsageWindow } from "../../shared/types.js";

export interface QuotaAlert {
  key: string;
  title: string;
  body: string;
}

const NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" } as const;

// One alert per window per reset once it crosses the threshold; seen is updated in place.
export function quotaAlerts(
  snapshots: LiveUsageSnapshot[],
  thresholdPct: number,
  seen: Set<string>,
  now = Date.now(),
): QuotaAlert[] {
  if (thresholdPct <= 0) {
    return [];
  }
  const out: QuotaAlert[] = [];
  for (const snapshot of snapshots) {
    for (const window of snapshot.windows) {
      const pct = usedPct(window);
      if (pct == null || pct < thresholdPct) {
        continue;
      }
      const key = `${snapshot.provider}:${window.label}:${window.resetsAt ?? "none"}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const reset = window.resetsAt ? `, resets in ${untilLabel(window.resetsAt, now)}` : "";
      out.push({
        key,
        title: `${NAMES[snapshot.provider]} ${window.label.toLowerCase()} window at ${pct}%`,
        body: `${100 - pct}% left${reset}.`,
      });
    }
  }
  return out;
}

function usedPct(window: UsageWindow): number | null {
  if (!(window.limit > 0)) {
    return null;
  }
  return Math.min(100, Math.round((window.used / window.limit) * 100));
}

function untilLabel(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) {
    return "a moment";
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
