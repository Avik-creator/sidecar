import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeRoot, codexRoot, cursorStateDb, homeDir } from "../paths.js";
import { asRecord, asString } from "../text.js";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
  accountId: string | null;
  scopes: string[];
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export function readClaudeTokens(): OAuthTokens | null {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const stored = readClaudeStoredTokens();
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: stored?.refreshToken ?? null,
      expiresAtMs: stored?.expiresAtMs ?? null,
      accountId: stored?.accountId ?? null,
      scopes: stored?.scopes ?? [],
      subscriptionType: stored?.subscriptionType ?? null,
      rateLimitTier: stored?.rateLimitTier ?? null,
    };
  }
  return stored;
}

export function readCodexTokens(): OAuthTokens | null {
  for (const filePath of codexAuthPaths()) {
    const parsed = readJsonFile(filePath);
    const tokens = codexTokensFromAuth(parsed);
    if (tokens) {
      return tokens;
    }
  }
  return tokensFromKeychain(["Codex Auth"]);
}

export function readCursorTokens(): OAuthTokens | null {
  const sqlite = readCursorSqliteTokens();
  if (sqlite?.accessToken || sqlite?.refreshToken) {
    return {
      accessToken: sqlite.accessToken ?? "",
      refreshToken: sqlite.refreshToken,
      expiresAtMs: jwtExpiryMs(sqlite.accessToken),
      accountId: jwtSubject(sqlite.accessToken),
      scopes: [],
      subscriptionType: sqlite.membershipType,
      rateLimitTier: null,
    };
  }
  const keychainAccess = readKeychainSecret("cursor-access-token");
  const keychainRefresh = readKeychainSecret("cursor-refresh-token");
  if (!keychainAccess && !keychainRefresh) {
    return null;
  }
  return {
    accessToken: keychainAccess ?? "",
    refreshToken: keychainRefresh,
    expiresAtMs: jwtExpiryMs(keychainAccess),
    accountId: jwtSubject(keychainAccess),
    scopes: [],
    subscriptionType: null,
    rateLimitTier: null,
  };
}

export function chatgptAccountId(token: string | null, stored: string | null): string | null {
  if (stored?.trim()) {
    return stored.trim();
  }
  const payload = jwtPayload(token);
  const auth = asRecord(payload?.["https://api.openai.com/auth"]);
  return asString(auth?.chatgpt_account_id);
}

export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

export function jwtExpiryMs(token: string | null | undefined): number | null {
  const payload = jwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

export function jwtSubject(token: string | null | undefined): string | null {
  const sub = jwtPayload(token)?.sub;
  return typeof sub === "string" && sub.trim() ? sub.trim() : null;
}

export function jwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function parseStoredJson(text: string): unknown {
  const direct = tryJson(text);
  if (direct) {
    return direct;
  }
  let hex = text.trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) {
    hex = hex.slice(2);
  }
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  try {
    return tryJson(Buffer.from(hex, "hex").toString("utf8"));
  } catch {
    return null;
  }
}

function readClaudeStoredTokens(): OAuthTokens | null {
  const fromKeychain = tokensFromKeychain(claudeKeychainServices());
  if (fromKeychain) {
    return fromKeychain;
  }
  return claudeTokensFromParsed(readJsonFile(path.join(claudeRoot(), ".credentials.json")));
}

function claudeTokensFromParsed(parsed: unknown): OAuthTokens | null {
  const oauth = asRecord(asRecord(parsed)?.claudeAiOauth);
  const accessToken = asString(oauth?.accessToken)?.trim();
  if (!oauth || !accessToken) {
    return null;
  }
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  return {
    accessToken,
    refreshToken: asString(oauth.refreshToken),
    expiresAtMs: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    accountId: null,
    scopes,
    subscriptionType: asString(oauth.subscriptionType),
    rateLimitTier: asString(oauth.rateLimitTier),
  };
}

function codexTokensFromAuth(parsed: unknown): OAuthTokens | null {
  const rec = asRecord(parsed);
  const nested = asRecord(rec?.tokens);
  if (!nested) {
    return null;
  }
  const accessToken = asString(nested.access_token)?.trim();
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    refreshToken: asString(nested.refresh_token),
    expiresAtMs: jwtExpiryMs(accessToken),
    accountId: asString(nested.account_id),
    scopes: [],
    subscriptionType: null,
    rateLimitTier: null,
  };
}

function tokensFromKeychain(services: string[]): OAuthTokens | null {
  for (const service of services) {
    const raw = readKeychainSecret(service);
    if (!raw) {
      continue;
    }
    const parsed = parseStoredJson(raw);
    const claude = claudeTokensFromParsed(parsed);
    if (claude) {
      return claude;
    }
    const codex = codexTokensFromAuth(parsed);
    if (codex) {
      return codex;
    }
  }
  return null;
}

function claudeKeychainServices(): string[] {
  const suffix = process.env.USER_TYPE === "ant" && truthy(process.env.USE_STAGING_OAUTH)
    ? "-staging-oauth"
    : process.env.USER_TYPE === "ant" && truthy(process.env.USE_LOCAL_OAUTH)
      ? "-local-oauth"
      : "";
  const base = `Claude Code${suffix}-credentials`;
  const hashed = claudeKeychainHashSuffix();
  return hashed ? [`${base}-${hashed}`, base] : [base];
}

function claudeKeychainHashSuffix(): string | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configDir) {
    return null;
  }
  const normalized = configDir.normalize("NFC");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

function codexAuthPaths(): string[] {
  const home = process.env.CODEX_HOME?.trim();
  if (home) {
    return [path.join(home, "auth.json")];
  }
  return [path.join(codexRoot(), "auth.json"), path.join(homeDir(), ".config", "codex", "auth.json")];
}

function readCursorSqliteTokens(): {
  accessToken: string | null;
  refreshToken: string | null;
  membershipType: string | null;
} | null {
  const dbPath = cursorStateDb();
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    db.exec("PRAGMA query_only = ON");
    return {
      accessToken: readItemTable(db, "cursorAuth/accessToken"),
      refreshToken: readItemTable(db, "cursorAuth/refreshToken"),
      membershipType: readItemTable(db, "cursorAuth/stripeMembershipType")?.trim().toLowerCase() ?? null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function readItemTable(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1").get(key) as
    | { value?: unknown }
    | undefined;
  const value = row?.value;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString("utf8").trim();
    return text || null;
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8").trim();
    return text || null;
  }
  return null;
}

function readJsonFile(filePath: string): unknown {
  try {
    return parseStoredJson(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function currentUsername(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? null;
  }
}

function readKeychainSecret(service: string): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  const username = currentUsername();
  const attempts = [
    ...(username ? [["find-generic-password", "-a", username, "-s", service, "-w"]] : []),
    ["find-generic-password", "-s", service, "-w"],
  ];
  for (const args of attempts) {
    try {
      const value = execFileSync("security", args, {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (value) {
        return value;
      }
    } catch {
      // Missing items are expected; never log the secret or stderr.
    }
  }
  return null;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function truthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no" && lower !== "off";
}
