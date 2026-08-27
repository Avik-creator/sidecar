import fs from "node:fs";
import path from "node:path";
import { SIDECAR_VERSION } from "../constants.js";
import { homeDir, sidecarHome } from "../paths.js";
import { asRecord, asString } from "../text.js";
import type { Harness, LiveUsageSnapshot } from "../../shared/types.js";
import {
  chatgptAccountId,
  jwtExpiryMs,
  looksLikeJwt,
  readClaudeTokens,
  readCodexTokens,
  readCursorTokens,
  type OAuthTokens,
} from "./credentials.js";
import { isAuthStatus, parseJsonBody, parseRetryAfterMs, requestJson, type HttpRequest, type HttpResponse } from "./http.js";
import {
  emptySnapshot,
  formatPlanLabel,
  parseClaudeUsage,
  parseCodexUsage,
  parseCursorRequestUsage,
  parseCursorUsage,
} from "./parse.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const LIVE_CACHE_VERSION = 2;
const REFRESH_SKEW_MS = 60_000;
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const LIVE_NOTE = "Sidecar never writes your agent credentials.";

interface LiveUsageDeps {
  now: () => number;
  request: (input: HttpRequest) => Promise<HttpResponse>;
  readClaude: () => OAuthTokens | null;
  readCodex: () => OAuthTokens | null;
  readCursor: () => OAuthTokens | null;
  persist: (snapshots: LiveUsageSnapshot[]) => void;
  loadPersisted: () => LiveUsageSnapshot[];
  sidecarUserAgent: string;
  claudeCodeUserAgent: string;
}

interface CacheEntry {
  snapshot: LiveUsageSnapshot;
  retryAfterUntil: number;
}

let memoryCache = new Map<Harness, CacheEntry>();
let inflight: Promise<LiveUsageSnapshot[]> | null = null;
let claudeUserAgent: string | null = null;
let cacheSeeded = false;
let pendingRetryAfterMs = new Map<Harness, number>();

export function resetLiveUsageCacheForTests(): void {
  memoryCache = new Map();
  inflight = null;
  claudeUserAgent = null;
  cacheSeeded = false;
  pendingRetryAfterMs = new Map();
}

export async function fetchLiveUsage(overrides: Partial<LiveUsageDeps> = {}): Promise<LiveUsageSnapshot[]> {
  if (process.env.VITEST && !overrides.request) {
    throw new Error("fetchLiveUsage requires a mocked request in tests");
  }
  const deps = resolveDeps(overrides);
  seedCache(deps);
  if (inflight) {
    return inflight;
  }
  inflight = fetchAll(deps).finally(() => {
    inflight = null;
  });
  return inflight;
}

export function liveUsageNotes(snapshots: LiveUsageSnapshot[]): string[] {
  if (snapshots.length === 0) {
    return [];
  }
  return [LIVE_NOTE];
}

function resolveDeps(overrides: Partial<LiveUsageDeps>): LiveUsageDeps {
  const skipPersist = Boolean(process.env.VITEST);
  return {
    now: overrides.now ?? Date.now,
    request: overrides.request ?? requestJson,
    readClaude: overrides.readClaude ?? readClaudeTokens,
    readCodex: overrides.readCodex ?? readCodexTokens,
    readCursor: overrides.readCursor ?? readCursorTokens,
    persist: overrides.persist ?? (skipPersist ? () => undefined : persistSnapshots),
    loadPersisted: overrides.loadPersisted ?? (skipPersist ? () => [] : loadPersistedSnapshots),
    sidecarUserAgent: overrides.sidecarUserAgent ?? `Sidecar/${SIDECAR_VERSION}`,
    claudeCodeUserAgent: overrides.claudeCodeUserAgent ?? `claude-code/${detectClaudeCodeVersion()}`,
  };
}

async function fetchAll(deps: LiveUsageDeps): Promise<LiveUsageSnapshot[]> {
  const snapshots = await Promise.all([
    probeCached(deps, "claude", () => probeClaude(deps)),
    probeCached(deps, "codex", () => probeCodex(deps)),
    probeCached(deps, "cursor", () => probeCursor(deps)),
  ]);
  try {
    deps.persist(snapshots);
  } catch {
    // Snapshot persistence is best-effort and never includes credentials.
  }
  return snapshots;
}

async function probeCached(
  deps: LiveUsageDeps,
  provider: Harness,
  probe: () => Promise<LiveUsageSnapshot>,
): Promise<LiveUsageSnapshot> {
  const now = deps.now();
  const cached = memoryCache.get(provider);
  if (cached && (cached.retryAfterUntil > now || isFresh(cached.snapshot, now))) {
    return cached.snapshot;
  }
  const snapshot = stampFetchedAt(await probe(), now);
  const retryMs = pendingRetryAfterMs.get(provider);
  pendingRetryAfterMs.delete(provider);
  memoryCache.set(provider, {
    snapshot,
    retryAfterUntil: retryMs != null ? now + retryMs : 0,
  });
  return snapshot;
}

function isFresh(snapshot: LiveUsageSnapshot, now: number): boolean {
  if (!snapshot.fetchedAt) {
    return false;
  }
  const fetched = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetched) && now - fetched < CACHE_TTL_MS;
}

function stampFetchedAt(snapshot: LiveUsageSnapshot, now: number): LiveUsageSnapshot {
  return snapshot.fetchedAt ? snapshot : { ...snapshot, fetchedAt: new Date(now).toISOString() };
}

async function probeClaude(deps: LiveUsageDeps): Promise<LiveUsageSnapshot> {
  const previous = memoryCache.get("claude")?.snapshot;
  const tokens = await ensureFresh(deps.readClaude(), (current) => refreshClaude(deps, current), deps.now());
  if (!tokens?.accessToken) {
    return emptySnapshot("claude", "unauthenticated", "Claude Code is not signed in");
  }
  if (tokens.accessToken.startsWith("sk-ant-api")) {
    return emptySnapshot("claude", "unavailable", "Claude API keys cannot fetch live plan usage");
  }

  const requestUsage = (token: string, userAgent: string) =>
    deps.request({
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
        "User-Agent": userAgent,
      },
    });

  try {
    const sidecarUa = deps.sidecarUserAgent;
    const compatibilityUa = deps.claudeCodeUserAgent;
    let userAgent = claudeUserAgent ?? sidecarUa;
    let tokensNow = tokens;
    let response = await requestUsage(tokensNow.accessToken, userAgent);

    if (isAuthStatus(response.status) && tokensNow.refreshToken) {
      const refreshed = await refreshClaude(deps, tokensNow);
      if (refreshed?.accessToken) {
        tokensNow = refreshed;
        response = await requestUsage(tokensNow.accessToken, userAgent);
      }
    }

    if (response.status === 429 && userAgent === sidecarUa) {
      userAgent = compatibilityUa;
      response = await requestUsage(tokensNow.accessToken, userAgent);
    }

    if (response.status === 429) {
      return rateLimited("claude", previous, response.headers, deps.now());
    }
    if (isAuthStatus(response.status)) {
      return emptySnapshot("claude", "unauthenticated", shortError(response));
    }
    if (response.status < 200 || response.status >= 300) {
      return failed("claude", previous, shortError(response));
    }

    claudeUserAgent = userAgent;
    const plan = formatPlanLabel(tokensNow.subscriptionType ?? tokensNow.rateLimitTier);
    return parseClaudeUsage(parseJsonBody(response.bodyText), plan, new Date(deps.now()).toISOString());
  } catch (error) {
    return failed("claude", previous, errorMessage(error));
  }
}

async function probeCodex(deps: LiveUsageDeps): Promise<LiveUsageSnapshot> {
  const previous = memoryCache.get("codex")?.snapshot;
  const tokens = await ensureFresh(deps.readCodex(), (current) => refreshCodex(deps, current), deps.now());
  if (!tokens?.accessToken) {
    return emptySnapshot("codex", "unauthenticated", "Codex is not signed in");
  }
  if (!looksLikeJwt(tokens.accessToken)) {
    return emptySnapshot("codex", "unavailable", "Codex API keys cannot fetch live plan usage");
  }

  try {
    let tokensNow = tokens;
    let response = await requestCodexUsage(deps, tokensNow);
    if (isAuthStatus(response.status) && tokensNow.refreshToken) {
      const refreshed = await refreshCodex(deps, tokensNow);
      if (refreshed?.accessToken) {
        tokensNow = refreshed;
        response = await requestCodexUsage(deps, tokensNow);
      }
    }
    if (response.status === 429) {
      return rateLimited("codex", previous, response.headers, deps.now());
    }
    if (isAuthStatus(response.status)) {
      return emptySnapshot("codex", "unauthenticated", shortError(response));
    }
    if (response.status < 200 || response.status >= 300) {
      return failed("codex", previous, shortError(response));
    }
    const fetchedAt = new Date(deps.now()).toISOString();
    const parsed = parseCodexUsage(parseJsonBody(response.bodyText), response.headers, fetchedAt);
    const reset = await requestCodexResetCredits(deps, tokensNow);
    if (!reset) {
      return parsed;
    }
    const count = finiteCount(asRecord(parseJsonBody(reset.bodyText))?.available_count);
    if (count == null || parsed.details.some((row) => row.label === "Rate limit resets")) {
      return parsed;
    }
    return {
      ...parsed,
      details: [...parsed.details, { label: "Rate limit resets", value: `${count} available` }],
    };
  } catch (error) {
    return failed("codex", previous, errorMessage(error));
  }
}

async function probeCursor(deps: LiveUsageDeps): Promise<LiveUsageSnapshot> {
  const previous = memoryCache.get("cursor")?.snapshot;
  const tokens = await ensureFresh(deps.readCursor(), (current) => refreshCursor(deps, current), deps.now());
  if (!tokens || (!tokens.accessToken && !tokens.refreshToken)) {
    return emptySnapshot("cursor", "unauthenticated", "Cursor is not signed in");
  }
  try {
    let tokensNow = tokens;
    if (!tokensNow.accessToken && tokensNow.refreshToken) {
      const refreshed = await refreshCursor(deps, tokensNow);
      if (refreshed) {
        tokensNow = refreshed;
      }
    }
    if (!tokensNow.accessToken) {
      return emptySnapshot("cursor", "unauthenticated", "Cursor is not signed in");
    }

    const fetchedAt = () => new Date(deps.now()).toISOString();
    const call = (token: string) => requestCursorDashboard(deps, token);

    let usageResponse = await call(tokensNow.accessToken);
    if (isAuthStatus(usageResponse.status) && tokensNow.refreshToken) {
      const refreshed = await refreshCursor(deps, tokensNow);
      if (refreshed?.accessToken) {
        tokensNow = refreshed;
        usageResponse = await call(tokensNow.accessToken);
      }
    }
    if (usageResponse.status === 429) {
      return rateLimited("cursor", previous, usageResponse.headers, deps.now());
    }

    const planName = tokensNow.subscriptionType ?? (await readCursorPlanName(deps, tokensNow.accessToken));
    if (usageResponse.status >= 200 && usageResponse.status < 300) {
      const parsed = parseCursorUsage(parseJsonBody(usageResponse.bodyText), planName, fetchedAt());
      if (parsed.status === "ok") {
        return withCursorCredits(deps, tokensNow.accessToken, parsed);
      }
    }

    const fallback = await deps.request({
      method: "GET",
      url: "https://cursor.com/api/usage",
      headers: {
        Authorization: `Bearer ${tokensNow.accessToken}`,
        Accept: "application/json",
        "User-Agent": deps.sidecarUserAgent,
      },
    });
    if (fallback.status === 429) {
      return rateLimited("cursor", previous, fallback.headers, deps.now());
    }
    if (isAuthStatus(fallback.status) && isAuthStatus(usageResponse.status)) {
      return emptySnapshot("cursor", "unauthenticated", shortError(fallback));
    }
    if (fallback.status >= 200 && fallback.status < 300) {
      const parsed = parseCursorRequestUsage(parseJsonBody(fallback.bodyText), planName, fetchedAt());
      if (parsed.status === "ok") {
        return parsed;
      }
    }
    return failed("cursor", previous, shortError(usageResponse.status >= 200 && usageResponse.status < 300 ? fallback : usageResponse));
  } catch (error) {
    return failed("cursor", previous, errorMessage(error));
  }
}

async function requestCodexUsage(deps: LiveUsageDeps, tokens: OAuthTokens): Promise<HttpResponse> {
  const accountId = chatgptAccountId(tokens.accessToken, tokens.accountId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/json",
    "User-Agent": deps.sidecarUserAgent,
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  return deps.request({
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers,
  });
}

async function requestCodexResetCredits(deps: LiveUsageDeps, tokens: OAuthTokens): Promise<HttpResponse | null> {
  try {
    const accountId = chatgptAccountId(tokens.accessToken, tokens.accountId);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: "application/json",
      "User-Agent": deps.sidecarUserAgent,
    };
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }
    const response = await deps.request({
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      headers,
    });
    return response.status >= 200 && response.status < 300 ? response : null;
  } catch {
    return null;
  }
}

async function requestCursorDashboard(deps: LiveUsageDeps, token: string): Promise<HttpResponse> {
  return deps.request({
    method: "POST",
    url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    headers: {
      Authorization: `Bearer ${token}`,
      "Connect-Protocol-Version": "1",
      "Content-Type": "application/json",
      "User-Agent": deps.sidecarUserAgent,
    },
    bodyText: "{}",
  });
}

async function readCursorPlanName(deps: LiveUsageDeps, token: string): Promise<string | null> {
  try {
    const response = await deps.request({
      method: "POST",
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
      headers: {
        Authorization: `Bearer ${token}`,
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
        "User-Agent": deps.sidecarUserAgent,
      },
      bodyText: "{}",
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const rec = asRecord(parseJsonBody(response.bodyText));
    const planInfo = asRecord(rec?.planInfo);
    return (
      asString(planInfo?.planName) ??
      asString(planInfo?.membershipType) ??
      asString(rec?.planName) ??
      asString(rec?.membershipType)
    );
  } catch {
    return null;
  }
}

async function withCursorCredits(
  deps: LiveUsageDeps,
  token: string,
  snapshot: LiveUsageSnapshot,
): Promise<LiveUsageSnapshot> {
  try {
    const response = await deps.request({
      method: "POST",
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance",
      headers: {
        Authorization: `Bearer ${token}`,
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
        "User-Agent": deps.sidecarUserAgent,
      },
      bodyText: "{}",
    });
    if (response.status < 200 || response.status >= 300) {
      return snapshot;
    }
    const rec = asRecord(parseJsonBody(response.bodyText));
    const remainingCents =
      finiteCount(rec?.remainingCents) ??
      finiteCount(rec?.balanceCents) ??
      finiteCount(asRecord(rec?.balance)?.cents);
    if (remainingCents == null) {
      return snapshot;
    }
    return {
      ...snapshot,
      details: [...snapshot.details, { label: "Credit grants", value: `$${(remainingCents / 100).toFixed(2)}` }],
    };
  } catch {
    return snapshot;
  }
}

async function ensureFresh(
  tokens: OAuthTokens | null,
  refresh: (current: OAuthTokens) => Promise<OAuthTokens | null>,
  now: number,
): Promise<OAuthTokens | null> {
  if (!tokens) {
    return null;
  }
  const expiry = tokens.expiresAtMs ?? jwtExpiryMs(tokens.accessToken);
  if (expiry != null && expiry - REFRESH_SKEW_MS <= now && tokens.refreshToken) {
    return (await refresh(tokens)) ?? tokens;
  }
  return tokens;
}

async function refreshClaude(deps: LiveUsageDeps, tokens: OAuthTokens): Promise<OAuthTokens | null> {
  if (!tokens.refreshToken) {
    return null;
  }
  try {
    const response = await deps.request({
      method: "POST",
      url: "https://platform.claude.com/v1/oauth/token",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": deps.sidecarUserAgent,
      },
      bodyText: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    return tokensFromRefresh(parseJsonBody(response.bodyText), tokens, deps.now());
  } catch {
    return null;
  }
}

async function refreshCodex(deps: LiveUsageDeps, tokens: OAuthTokens): Promise<OAuthTokens | null> {
  if (!tokens.refreshToken) {
    return null;
  }
  try {
    const response = await deps.request({
      method: "POST",
      url: "https://auth.openai.com/oauth/token",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": deps.sidecarUserAgent,
      },
      bodyText: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    return tokensFromRefresh(parseJsonBody(response.bodyText), tokens, deps.now());
  } catch {
    return null;
  }
}

async function refreshCursor(deps: LiveUsageDeps, tokens: OAuthTokens): Promise<OAuthTokens | null> {
  if (!tokens.refreshToken) {
    return null;
  }
  try {
    const response = await deps.request({
      method: "POST",
      url: "https://api2.cursor.sh/oauth/token",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": deps.sidecarUserAgent,
      },
      bodyText: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CURSOR_CLIENT_ID,
      }).toString(),
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    return tokensFromRefresh(parseJsonBody(response.bodyText), tokens, deps.now());
  } catch {
    return null;
  }
}

function tokensFromRefresh(body: unknown, previous: OAuthTokens, now: number): OAuthTokens | null {
  const rec = asRecord(body);
  const accessToken = asString(rec?.access_token) ?? asString(rec?.accessToken);
  if (!accessToken) {
    return null;
  }
  const expiresIn = typeof rec?.expires_in === "number" ? rec.expires_in : null;
  const expiresAt = typeof rec?.expires_at === "number" ? rec.expires_at : typeof rec?.expiresAt === "number" ? rec.expiresAt : null;
  return {
    ...previous,
    accessToken,
    refreshToken: asString(rec?.refresh_token) ?? asString(rec?.refreshToken) ?? previous.refreshToken,
    expiresAtMs: expiresAt ?? (expiresIn != null ? now + expiresIn * 1000 : previous.expiresAtMs),
    accountId: chatgptAccountId(accessToken, previous.accountId),
  };
}

function rateLimited(
  provider: Harness,
  previous: LiveUsageSnapshot | undefined,
  headers: Record<string, string>,
  now: number,
): LiveUsageSnapshot {
  const retryMs = parseRetryAfterMs(headers, now) ?? CACHE_TTL_MS;
  pendingRetryAfterMs.set(provider, retryMs);
  if (previous?.windows.length) {
    return {
      ...previous,
      status: "rate_limited",
      error: "Provider rate limited the usage API",
    };
  }
  return emptySnapshot(provider, "rate_limited", "Provider rate limited the usage API");
}

function failed(provider: Harness, previous: LiveUsageSnapshot | undefined, error: string): LiveUsageSnapshot {
  if (previous?.windows.length) {
    return {
      ...previous,
      status: "stale",
      error,
    };
  }
  return emptySnapshot(provider, "unavailable", error);
}

function shortError(response: HttpResponse): string {
  const text = response.bodyText.replace(/\s+/g, " ").trim().slice(0, 160);
  return text ? `HTTP ${response.status}: ${text}` : `HTTP ${response.status}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError"
      ? "Usage request timed out"
      : error.message;
  }
  return String(error);
}

function finiteCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  return null;
}

function seedCache(deps: LiveUsageDeps): void {
  if (cacheSeeded || memoryCache.size > 0) {
    cacheSeeded = true;
    return;
  }
  cacheSeeded = true;
  try {
    for (const snapshot of deps.loadPersisted()) {
      memoryCache.set(snapshot.provider, { snapshot, retryAfterUntil: 0 });
    }
  } catch {
    // Ignore corrupt snapshot files.
  }
}

function persistSnapshots(snapshots: LiveUsageSnapshot[]): void {
  const dir = sidecarHome();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "usage-live.json");
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: LIVE_CACHE_VERSION, snapshots }, null, 2));
  fs.renameSync(tmp, dest);
}

function loadPersistedSnapshots(): LiveUsageSnapshot[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(sidecarHome(), "usage-live.json"), "utf8")) as unknown;
    const rec = asRecord(parsed);
    if (rec?.version !== LIVE_CACHE_VERSION) {
      return [];
    }
    const rows = rec.snapshots;
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.filter(isSnapshot);
  } catch {
    return [];
  }
}

function isSnapshot(value: unknown): value is LiveUsageSnapshot {
  const rec = asRecord(value);
  const provider = rec?.provider;
  return provider === "claude" || provider === "codex" || provider === "cursor";
}

function detectClaudeCodeVersion(): string {
  const fromEnv = process.env.CLAUDE_CODE_VERSION?.trim();
  if (fromEnv) {
    return fromEnv.replace(/^v/i, "");
  }
  const files = [
    path.join(homeDir(), ".local/lib/node_modules/@anthropic-ai/claude-code/package.json"),
    path.join("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/package.json"),
    path.join("/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json"),
  ];
  for (const file of files) {
    try {
      const rec = asRecord(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
      const version = asString(rec?.version)?.trim();
      if (version) {
        return version.replace(/^v/i, "");
      }
    } catch {
      // Keep looking.
    }
  }
  return "2.1.0";
}
