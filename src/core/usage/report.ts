import type { UsageCalendarDay, UsageDayRow, UsageReport } from "../../shared/types.js";
import { PRICE_VERSION } from "../constants.js";
import type { Store } from "../db/store.js";
import { displayTimezone } from "../paths.js";

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  gpt: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
};

function priceForModel(model: string | null): Price {
  const name = (model ?? "").toLowerCase();
  if (name.includes("haiku")) {
    return PRICES.haiku!;
  }
  if (name.includes("opus")) {
    return PRICES.opus!;
  }
  if (name.includes("sonnet") || name.includes("fable")) {
    return PRICES.sonnet!;
  }
  if (name.includes("gpt") || name.includes("codex")) {
    return PRICES.gpt!;
  }
  return PRICES.default!;
}

function usdEstimate(
  tokensIn: number,
  tokensOut: number,
  cacheRead: number,
  cacheWrite: number,
  model: string | null,
): number {
  const price = priceForModel(model);
  return (
    (tokensIn / 1_000_000) * price.input +
    (tokensOut / 1_000_000) * price.output +
    (cacheRead / 1_000_000) * price.cacheRead +
    (cacheWrite / 1_000_000) * price.cacheWrite
  );
}

export function buildUsageReport(store: Store, days = 30, timezone = displayTimezone()): UsageReport {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const grouped = new Map<string, UsageDayRow>();
  for (const row of store.usageRows()) {
    const ms = Date.parse(row.ts);
    if (!Number.isFinite(ms) || ms < cutoff) {
      continue;
    }
    const day = formatDay(ms, timezone);
    const model = row.model ?? "unknown";
    const key = `${day}|${row.harness}|${model}`;
    const current = grouped.get(key) ?? {
      day,
      harness: row.harness,
      model,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      usdEstimate: 0,
    };
    current.tokensIn += row.tokensIn;
    current.tokensOut += row.tokensOut;
    current.cacheRead += row.cacheRead;
    current.cacheWrite += row.cacheWrite;
    grouped.set(key, current);
  }

  const dayRows = [...grouped.values()]
    .map((row) => ({
      ...row,
      usdEstimate: usdEstimate(row.tokensIn, row.tokensOut, row.cacheRead, row.cacheWrite, row.model),
    }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.harness.localeCompare(b.harness));
  const calendarDays = calendarDaysFromRows(dayRows);

  const totals = dayRows.reduce(
    (acc, row) => {
      acc.tokensIn += row.tokensIn;
      acc.tokensOut += row.tokensOut;
      acc.cacheRead += row.cacheRead;
      acc.cacheWrite += row.cacheWrite;
      acc.usdEstimate += row.usdEstimate;
      return acc;
    },
    { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usdEstimate: 0 },
  );

  const notes = [
    "Claude Code token counts are exact; dollar amounts use Sidecar's versioned price table.",
    "Codex usage uses last_token_usage deltas from token_count events.",
    "Cursor local transcripts almost never include token counts. Live Cursor plan usage comes from the dashboard API when you're signed in.",
  ];

  return {
    timezone,
    priceVersion: PRICE_VERSION,
    days: dayRows,
    calendarDays,
    totals,
    live: [],
    notes,
  };
}

export function calendarDaysFromRows(rows: UsageDayRow[]): UsageCalendarDay[] {
  const map = new Map<string, UsageCalendarDay>();
  for (const row of rows) {
    const current = map.get(row.day) ?? { day: row.day, tokensIn: 0, tokensOut: 0, usdEstimate: 0 };
    current.tokensIn += row.tokensIn;
    current.tokensOut += row.tokensOut;
    current.usdEstimate += row.usdEstimate;
    map.set(row.day, current);
  }
  return [...map.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export function formatDay(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
