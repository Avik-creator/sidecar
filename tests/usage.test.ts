import { afterEach, describe, expect, it } from "vitest";
import type { OAuthTokens } from "../src/core/usage/credentials.js";
import { chatgptAccountId, jwtExpiryMs, jwtPayload, parseStoredJson } from "../src/core/usage/credentials.js";
import { parseRetryAfterMs, type HttpRequest, type HttpResponse } from "../src/core/usage/http.js";
import { fetchLiveUsage, resetLiveUsageCacheForTests } from "../src/core/usage/live.js";
import { parseClaudeUsage, parseCodexUsage, parseCursorUsage } from "../src/core/usage/parse.js";
import { calendarDaysFromRows, formatDay } from "../src/core/usage/report.js";

afterEach(() => {
  resetLiveUsageCacheForTests();
});

describe("usage parsers", () => {
  it("maps Claude windows and extra usage cents", () => {
    const snapshot = parseClaudeUsage(
      {
        five_hour: { utilization: 0, resets_at: "2026-08-27T12:00:00.000Z" },
        seven_day: { utilization: 41.2, resets_at: "2026-08-31T00:00:00.000Z" },
        seven_day_opus: { utilization: 12 },
        extra_usage: { is_enabled: true, used_credits: 2500, monthly_limit: 10000 },
      },
      "Max",
      "2026-08-27T10:00:00.000Z",
    );
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows[0]).toMatchObject({ label: "Session", used: 0, unit: "percent" });
    expect(snapshot.windows.find((row) => row.label === "Extra usage")).toMatchObject({
      used: 25,
      limit: 100,
      unit: "usd",
    });
  });

  it("prefers Claude limits[] over a stale seven_day utilization of 0", () => {
    const snapshot = parseClaudeUsage(
      {
        five_hour: { utilization: 21, resets_at: "2026-08-27T12:00:00.000Z" },
        seven_day: { utilization: 0, resets_at: "2026-09-03T00:00:00.000Z" },
        limits: [
          { kind: "session", percent: 21, resets_at: "2026-08-27T12:00:00.000Z" },
          { kind: "weekly_all", percent: 100, resets_at: "2026-09-03T00:00:00.000Z" },
          {
            kind: "weekly_scoped",
            percent: 80,
            resets_at: "2026-09-03T00:00:00.000Z",
            scope: { model: { display_name: "Fable" } },
          },
          { kind: "weekly_scoped", percent: 0, resets_at: null, scope: { model: { display_name: "Opus" } } },
        ],
      },
      "Max",
      "2026-08-27T10:00:00.000Z",
    );
    expect(snapshot.windows.find((row) => row.label === "Session")).toMatchObject({ used: 21 });
    expect(snapshot.windows.find((row) => row.label === "Weekly")).toMatchObject({ used: 100 });
    expect(snapshot.windows.find((row) => row.label === "Fable")).toMatchObject({ used: 80 });
    expect(snapshot.windows.some((row) => row.label === "Opus")).toBe(false);
    expect(snapshot.windows.filter((row) => row.label === "Weekly")).toHaveLength(1);
  });

  it("maps Codex windows from body and headers", () => {
    const snapshot = parseCodexUsage(
      {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 6, reset_at: 1787817600 },
          secondary_window: { used_percent: 24, reset_after_seconds: 3600 },
        },
        credits: { balance: 10 },
      },
      { "x-codex-primary-used-percent": "8" },
      "2026-08-27T10:00:00.000Z",
    );
    expect(snapshot.plan).toBe("Pro 20x");
    expect(snapshot.windows[0]?.used).toBe(8);
    expect(snapshot.windows[1]?.label).toBe("Weekly");
    expect(snapshot.details[0]?.value).toContain("10 credits");
  });

  it("maps Cursor plan usage from cents", () => {
    const snapshot = parseCursorUsage(
      {
        billingCycleEnd: 1787817600,
        planUsage: { totalPercentUsed: 33, autoPercentUsed: 10, totalSpend: 2500, limit: 10000, remaining: 7500 },
      },
      "pro",
      "2026-08-27T10:00:00.000Z",
    );
    expect(snapshot.plan).toBe("Pro");
    expect(snapshot.windows[0]).toMatchObject({ label: "Total usage", used: 33, unit: "percent" });
  });
});

describe("credential helpers", () => {
  it("parses hex-encoded credential JSON", () => {
    const json = JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "ref", expiresAt: 1 } });
    const parsed = parseStoredJson(Buffer.from(json, "utf8").toString("hex"));
    expect(parsed).toEqual({ claudeAiOauth: { accessToken: "tok", refreshToken: "ref", expiresAt: 1 } });
  });

  it("reads JWT expiry and ChatGPT account id", () => {
    const token = jwtToken({ exp: 1_780_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } });
    expect(jwtExpiryMs(token)).toBe(1_780_000_000_000);
    expect(chatgptAccountId(token, null)).toBe("acct_9");
    expect(jwtPayload("not-a-jwt")).toBeNull();
  });
});

describe("retry-after", () => {
  it("parses delta seconds and HTTP dates", () => {
    expect(parseRetryAfterMs({ "retry-after": "12" }, 0)).toBe(12_000);
    expect(parseRetryAfterMs({ "retry-after": "Thu, 01 Jan 1970 00:00:05 GMT" }, 0)).toBe(5_000);
    expect(parseRetryAfterMs({}, 0)).toBeNull();
  });
});

describe("live usage cache", () => {
  it("caches successful probes for five minutes", async () => {
    let now = 1_000_000;
    let calls = 0;
    const request = async (): Promise<HttpResponse> => {
      calls += 1;
      return jsonResponse(200, {
        five_hour: { utilization: 12, resets_at: "2026-08-27T12:00:00.000Z" },
        seven_day: { utilization: 4, resets_at: "2026-08-31T00:00:00.000Z" },
      });
    };
    const deps = {
      now: () => now,
      request,
      readClaude: () => claudeTokens(),
      readCodex: () => null,
      readCursor: () => null,
      persist: () => undefined,
      loadPersisted: () => [],
      sidecarUserAgent: "Sidecar/0.1.0",
      claudeCodeUserAgent: "claude-code/2.1.0",
    };

    const first = await fetchLiveUsage(deps);
    now += 60_000;
    const second = await fetchLiveUsage(deps);
    expect(first[0]?.windows[0]?.used).toBe(12);
    expect(second[0]?.status).toBe("ok");
    expect(calls).toBe(1);

    now += 5 * 60 * 1000;
    await fetchLiveUsage(deps);
    expect(calls).toBe(2);
  });

  it("keeps stale windows when a later probe fails", async () => {
    let now = 1_000_000;
    let calls = 0;
    const request = async (): Promise<HttpResponse> => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, {
          five_hour: { utilization: 20, resets_at: "2026-08-27T12:00:00.000Z" },
        });
      }
      return { status: 500, bodyText: "nope", headers: {} };
    };
    const deps = {
      now: () => now,
      request,
      readClaude: () => claudeTokens(),
      readCodex: () => null,
      readCursor: () => null,
      persist: () => undefined,
      loadPersisted: () => [],
    };
    const first = await fetchLiveUsage(deps);
    expect(first[0]?.status).toBe("ok");
    now += 6 * 60 * 1000;
    const second = await fetchLiveUsage(deps);
    expect(second[0]?.status).toBe("stale");
    expect(second[0]?.windows[0]?.used).toBe(20);
  });

  it("honors Retry-After and retries Claude with a compatibility user agent", async () => {
    let now = 1_000_000;
    const userAgents: string[] = [];
    const request = async (input: HttpRequest): Promise<HttpResponse> => {
      userAgents.push(input.headers?.["User-Agent"] ?? "");
      if (userAgents.length === 1) {
        return { status: 429, bodyText: "rate limited", headers: { "retry-after": "120" } };
      }
      return jsonResponse(200, { five_hour: { utilization: 9 } });
    };
    const first = await fetchLiveUsage({
      now: () => now,
      request,
      readClaude: () => claudeTokens(),
      readCodex: () => null,
      readCursor: () => null,
      persist: () => undefined,
      loadPersisted: () => [],
      sidecarUserAgent: "Sidecar/0.1.0",
      claudeCodeUserAgent: "claude-code/2.1.0",
    });
    expect(userAgents).toEqual(["Sidecar/0.1.0", "claude-code/2.1.0"]);
    expect(first[0]?.windows[0]?.used).toBe(9);

    resetLiveUsageCacheForTests();
    const limitedAgents: string[] = [];
    const limited = await fetchLiveUsage({
      now: () => now,
      request: async (input) => {
        limitedAgents.push(input.headers?.["User-Agent"] ?? "");
        return { status: 429, bodyText: "rate limited", headers: { "retry-after": "120" } };
      },
      readClaude: () => claudeTokens(),
      readCodex: () => null,
      readCursor: () => null,
      persist: () => undefined,
      loadPersisted: () => [],
      sidecarUserAgent: "Sidecar/0.1.0",
      claudeCodeUserAgent: "claude-code/2.1.0",
    });
    expect(limited[0]?.status).toBe("rate_limited");
    const afterFirst = limitedAgents.length;
    now += 30_000;
    await fetchLiveUsage({
      now: () => now,
      request: async () => {
        throw new Error("should not refetch during Retry-After");
      },
      readClaude: () => claudeTokens(),
      readCodex: () => null,
      readCursor: () => null,
      persist: () => undefined,
      loadPersisted: () => [],
    });
    expect(limitedAgents.length).toBe(afterFirst);
  });

  it("dedupes in-flight fetches", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = async (): Promise<HttpResponse> => {
      started += 1;
      await barrier;
      return jsonResponse(200, { five_hour: { utilization: 3 } });
    };
    const deps = {
      request,
      readClaude: () => claudeTokens(),
      readCodex: () => null,
      readCursor: () => null,
      persist: () => undefined,
      loadPersisted: () => [],
    };
    const pending = Promise.all([fetchLiveUsage(deps), fetchLiveUsage(deps)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(1);
    release?.();
    const [a, b] = await pending;
    expect(a[0]?.windows[0]?.used).toBe(3);
    expect(b[0]?.windows[0]?.used).toBe(3);
    expect(started).toBe(1);
  });

  it("refreshes expired Claude tokens in memory only", async () => {
    const urls: string[] = [];
    const persisted: unknown[] = [];
    const request = async (input: HttpRequest): Promise<HttpResponse> => {
      urls.push(input.url);
      if (input.url.includes("/v1/oauth/token")) {
        expect(input.bodyText).not.toContain("must-not-leak");
        return jsonResponse(200, { access_token: "sk-ant-oat01-new", expires_in: 3600 });
      }
      expect(input.headers?.Authorization).toBe("Bearer sk-ant-oat01-new");
      return jsonResponse(200, { five_hour: { utilization: 1 } });
    };
    await fetchLiveUsage({
      now: () => 2_000_000,
      request,
      readClaude: () => claudeTokens({ accessToken: "sk-ant-oat01-old", expiresAtMs: 1_000 }),
      readCodex: () => null,
      readCursor: () => null,
      persist: (snapshots) => {
        persisted.push(snapshots);
      },
      loadPersisted: () => [],
    });
    expect(urls.some((url) => url.includes("/v1/oauth/token"))).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain("sk-ant");
  });
});

describe("usage calendar days", () => {
  it("groups model rows into one total per calendar day", () => {
    const days = calendarDaysFromRows([
      {
        day: "2026-08-27",
        harness: "claude",
        model: "sonnet",
        tokensIn: 1,
        tokensOut: 2,
        cacheRead: 0,
        cacheWrite: 0,
        usdEstimate: 1.5,
      },
      {
        day: "2026-08-27",
        harness: "codex",
        model: "gpt",
        tokensIn: 3,
        tokensOut: 4,
        cacheRead: 0,
        cacheWrite: 0,
        usdEstimate: 2.25,
      },
      {
        day: "2026-08-26",
        harness: "claude",
        model: "haiku",
        tokensIn: 10,
        tokensOut: 1,
        cacheRead: 0,
        cacheWrite: 0,
        usdEstimate: 0.1,
      },
    ]);
    expect(days.map((row) => row.day)).toEqual(["2026-08-27", "2026-08-26"]);
    expect(days[0]).toMatchObject({ usdEstimate: 3.75, tokensIn: 4, tokensOut: 6 });
  });

  it("labels days in the requested timezone", () => {
    expect(formatDay(Date.parse("2026-08-27T02:30:00Z"), "UTC")).toBe("2026-08-27");
    expect(formatDay(Date.parse("2026-08-27T02:30:00Z"), "America/Los_Angeles")).toBe("2026-08-26");
  });
});

function claudeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "refresh",
    expiresAtMs: Date.now() + 3_600_000,
    accountId: null,
    scopes: ["user:profile"],
    subscriptionType: "max",
    rateLimitTier: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    bodyText: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

function jwtToken(payload: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `aaa.${json}.sig`;
}
