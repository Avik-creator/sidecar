import type { Harness, LiveUsageSnapshot, UsageWindow } from "../../shared/types.js";
import { asBool, asRecord, asString } from "../text.js";

export function emptySnapshot(
  provider: Harness,
  status: LiveUsageSnapshot["status"],
  error: string | null,
): LiveUsageSnapshot {
  return {
    provider,
    plan: null,
    status,
    fetchedAt: null,
    error,
    windows: [],
    details: [],
  };
}

export function parseClaudeUsage(data: unknown, plan: string | null, fetchedAt: string): LiveUsageSnapshot {
  const rec = asRecord(data) ?? {};
  const windows = mergeClaudeWindows(rec);
  const extra = asRecord(rec.extra_usage);
  const details: LiveUsageSnapshot["details"] = [];
  if (extra && asBool(extra.is_enabled)) {
    const used = centsToUsd(extra.used_credits);
    const limit = centsToUsd(extra.monthly_limit);
    if (limit != null && limit > 0 && used != null) {
      windows.push({ label: "Extra usage", used, limit, unit: "usd", resetsAt: null });
    } else if (used != null && used > 0) {
      details.push({ label: "Extra usage", value: `$${used.toFixed(2)}` });
    }
  }
  return {
    provider: "claude",
    plan,
    status: windows.length > 0 ? "ok" : "unavailable",
    fetchedAt,
    error: windows.length > 0 ? null : "Claude usage response had no windows",
    windows,
    details,
  };
}

export function parseCodexUsage(
  data: unknown,
  headers: Record<string, string>,
  fetchedAt: string,
): LiveUsageSnapshot {
  const rec = asRecord(data) ?? {};
  const rateLimit = asRecord(rec.rate_limit);
  const windows: UsageWindow[] = [];
  const primaryHeader = finiteNumber(headers["x-codex-primary-used-percent"]);
  const secondaryHeader = finiteNumber(headers["x-codex-secondary-used-percent"]);
  if (primaryHeader != null) {
    windows.push(percentWindow("Session", primaryHeader, isoFromWindow(asRecord(rateLimit?.primary_window))));
  } else {
    pushPercentWindow(windows, "Session", asRecord(rateLimit?.primary_window));
  }
  if (secondaryHeader != null) {
    windows.push(percentWindow("Weekly", secondaryHeader, isoFromWindow(asRecord(rateLimit?.secondary_window))));
  } else {
    pushPercentWindow(windows, "Weekly", asRecord(rateLimit?.secondary_window));
  }

  const extraLimits = rec.additional_rate_limits;
  if (Array.isArray(extraLimits)) {
    for (const entry of extraLimits) {
      const item = asRecord(entry);
      const nested = asRecord(item?.rate_limit);
      const name = shortenCodexLimitName(asString(item?.limit_name) ?? "Model");
      pushPercentWindow(windows, name, asRecord(nested?.primary_window));
      pushPercentWindow(windows, `${name} Weekly`, asRecord(nested?.secondary_window));
    }
  }

  const review = asRecord(asRecord(rec.code_review_rate_limit)?.primary_window);
  pushPercentWindow(windows, "Reviews", review);

  const details: LiveUsageSnapshot["details"] = [];
  const credits = asRecord(rec.credits);
  const creditBalance =
    finiteNumber(credits?.balance) ?? finiteNumber(headers["x-codex-credits-balance"]);
  if (creditBalance != null) {
    const remaining = Math.max(0, Math.floor(creditBalance));
    details.push({
      label: "Credits",
      value: `$${(remaining * 0.04).toFixed(2)} · ${remaining} credits`,
    });
  }
  const resets = asRecord(rec.rate_limit_reset_credits);
  const resetCount = finiteNumber(resets?.available_count);
  if (resetCount != null) {
    details.push({ label: "Rate limit resets", value: `${Math.floor(resetCount)} available` });
  }

  return {
    provider: "codex",
    plan: formatCodexPlan(asString(rec.plan_type)),
    status: windows.length > 0 || details.length > 0 ? "ok" : "unavailable",
    fetchedAt,
    error: windows.length > 0 || details.length > 0 ? null : "Codex usage response had no windows",
    windows,
    details,
  };
}

export function parseCursorUsage(
  data: unknown,
  planName: string | null,
  fetchedAt: string,
): LiveUsageSnapshot {
  const rec = asRecord(data) ?? {};
  const pu = asRecord(rec.planUsage);
  const windows: UsageWindow[] = [];
  const details: LiveUsageSnapshot["details"] = [];
  const cycleEnd = toIso(rec.billingCycleEnd);
  const normalizedPlan = (planName ?? "").toLowerCase();
  const su = asRecord(rec.spendLimitUsage);
  const isTeam =
    normalizedPlan === "team" ||
    asString(su?.limitType) === "team" ||
    (typeof su?.pooledLimit === "number" && su.pooledLimit > 0);

  if (pu) {
    const limitCents = finiteNumber(pu.limit);
    const totalSpend = finiteNumber(pu.totalSpend);
    const remaining = finiteNumber(pu.remaining);
    const percent = finiteNumber(pu.totalPercentUsed);
    if (isTeam && limitCents != null && limitCents > 0) {
      const used = centsToUsd(totalSpend ?? (remaining != null ? limitCents - remaining : 0)) ?? 0;
      windows.push({
        label: "Total usage",
        used,
        limit: centsToUsd(limitCents) ?? 0,
        unit: "usd",
        resetsAt: cycleEnd,
      });
    } else if (percent != null) {
      windows.push(percentWindow("Total usage", percent, cycleEnd));
    } else if (limitCents != null && limitCents > 0) {
      const usedCents = totalSpend ?? (remaining != null ? limitCents - remaining : 0);
      windows.push({
        label: "Total usage",
        used: centsToUsd(usedCents) ?? 0,
        limit: centsToUsd(limitCents) ?? 0,
        unit: "usd",
        resetsAt: cycleEnd,
      });
    }
    const autoPercent = finiteNumber(pu.autoPercentUsed);
    if (autoPercent != null) {
      windows.push(percentWindow("Auto usage", autoPercent, cycleEnd));
    }
    const apiPercent = finiteNumber(pu.apiPercentUsed);
    if (apiPercent != null) {
      windows.push(percentWindow("API usage", apiPercent, cycleEnd));
    }
    const bonus = centsToUsd(pu.bonusSpend);
    if (bonus != null && bonus > 0) {
      details.push({ label: "Bonus spend", value: `$${bonus.toFixed(2)}` });
    }
  }

  if (su) {
    const limit = finiteNumber(su.individualLimit) ?? finiteNumber(su.pooledLimit) ?? 0;
    const remaining = finiteNumber(su.individualRemaining) ?? finiteNumber(su.pooledRemaining) ?? 0;
    if (limit > 0) {
      windows.push({
        label: "On-demand",
        used: centsToUsd(limit - remaining) ?? 0,
        limit: centsToUsd(limit) ?? 0,
        unit: "usd",
        resetsAt: null,
      });
    }
  }

  return {
    provider: "cursor",
    plan: formatPlanLabel(planName),
    status: windows.length > 0 ? "ok" : "unavailable",
    fetchedAt,
    error: windows.length > 0 ? null : "Cursor usage response had no windows",
    windows,
    details,
  };
}

export function parseCursorRequestUsage(data: unknown, planName: string | null, fetchedAt: string): LiveUsageSnapshot {
  const rec = asRecord(data) ?? {};
  const gpt4 = asRecord(rec["gpt-4"]);
  const max = finiteNumber(gpt4?.maxRequestUsage);
  const used = finiteNumber(gpt4?.numRequests) ?? 0;
  if (max == null || max <= 0) {
    return emptySnapshot("cursor", "unavailable", "Cursor request-based usage unavailable");
  }
  return {
    provider: "cursor",
    plan: formatPlanLabel(planName),
    status: "ok",
    fetchedAt,
    error: null,
    windows: [
      {
        label: "Requests",
        used,
        limit: max,
        unit: "count",
        resetsAt: toIso(rec.startOfMonth),
      },
    ],
    details: [],
  };
}

export function formatPlanLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatCodexPlan(planType: string | null): string | null {
  if (!planType) {
    return null;
  }
  const lower = planType.trim().toLowerCase();
  if (lower === "prolite") {
    return "Pro 5x";
  }
  if (lower === "pro") {
    return "Pro 20x";
  }
  return formatPlanLabel(planType);
}

function mergeClaudeWindows(rec: Record<string, unknown>): UsageWindow[] {
  const fromLimits = parseClaudeLimits(rec.limits);
  const fromLegacy: UsageWindow[] = [];
  pushPercentWindow(fromLegacy, "Session", rec.five_hour);
  pushPercentWindow(fromLegacy, "Weekly", rec.seven_day);
  pushPercentWindow(fromLegacy, "Opus", rec.seven_day_opus);
  pushPercentWindow(fromLegacy, "Sonnet", rec.seven_day_sonnet);
  pushPercentWindow(fromLegacy, "Claude Design", rec.seven_day_omelette);
  if (fromLimits.length === 0) {
    return fromLegacy;
  }
  const seen = new Set(fromLimits.map((row) => row.label));
  const windows = [...fromLimits];
  for (const row of fromLegacy) {
    if (seen.has(row.label)) {
      continue;
    }
    seen.add(row.label);
    windows.push(row);
  }
  return windows;
}

function parseClaudeLimits(raw: unknown): UsageWindow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) {
      continue;
    }
    const used = windowPercent(rec);
    if (used == null) {
      continue;
    }
    const resetsAt = isoFromWindow(rec);
    if (used === 0 && resetsAt == null) {
      continue;
    }
    const label = claudeLimitLabel(rec);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    windows.push(percentWindow(label, used, resetsAt));
  }
  return windows;
}

function claudeLimitLabel(rec: Record<string, unknown>): string | null {
  const kind = asString(rec.kind)?.trim().toLowerCase() ?? "";
  const modelName = asString(asRecord(asRecord(rec.scope)?.model)?.display_name)?.trim() ?? null;
  switch (kind) {
    case "session":
      return "Session";
    case "weekly_all":
    case "weekly":
      return "Weekly";
    case "weekly_scoped":
      return modelName || "Weekly model";
    case "credits":
    case "extra_usage":
    case "spend":
      return null;
    default:
      return modelName || (kind ? formatPlanLabel(kind) : null);
  }
}

function pushPercentWindow(windows: UsageWindow[], label: string, raw: unknown): void {
  const rec = asRecord(raw);
  const used = windowPercent(rec);
  if (used == null) {
    return;
  }
  windows.push(percentWindow(label, used, isoFromWindow(rec)));
}

function windowPercent(rec: Record<string, unknown> | null): number | null {
  if (!rec) {
    return null;
  }
  let max: number | null = null;
  for (const key of ["percent", "used_percent", "utilization"] as const) {
    const n = finiteNumber(rec[key]);
    if (n == null) {
      continue;
    }
    max = max == null ? n : Math.max(max, n);
  }
  return max;
}

function percentWindow(label: string, used: number, resetsAt: string | null): UsageWindow {
  return { label, used, limit: 100, unit: "percent", resetsAt };
}

function isoFromWindow(rec: Record<string, unknown> | null): string | null {
  if (!rec) {
    return null;
  }
  if (typeof rec.reset_at === "number") {
    return toIso(rec.reset_at);
  }
  if (typeof rec.reset_after_seconds === "number") {
    return new Date(Date.now() + rec.reset_after_seconds * 1000).toISOString();
  }
  return toIso(rec.resets_at);
}

function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return toIso(numeric);
    }
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function centsToUsd(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null) {
    return null;
  }
  return n / 100;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function shortenCodexLimitName(name: string): string {
  const short = name.replace(/^GPT-[\d.]+-Codex-/, "");
  return short || name || "Model";
}
