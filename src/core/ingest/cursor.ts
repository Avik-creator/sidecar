import { DatabaseSync } from "node:sqlite";
import type { ParsedBatch } from "./claude.js";
import { emptyBatch } from "./claude.js";
import { asBool, asNumber, asRecord, asString, extractText, truncateText } from "../text.js";
import type { SessionRecord, TurnRecord } from "../../shared/types.js";

function asRows<T>(value: unknown): T {
  return value as T;
}

interface CursorIngestResult {
  watermark: string;
  parseFailures: number;
  unavailable: boolean;
  error?: string;
}

// Emits one batch per conversation; the bubble table holds tens of thousands of rows.
export function ingestCursor(
  dbPath: string,
  watermark: string | null,
  onBatch: (batch: ParsedBatch) => void,
): CursorIngestResult {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return {
      watermark: watermark ?? "0",
      parseFailures: 0,
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 2000");
    const since = Number(watermark ?? "0");
    const headers = asRows<CursorHeaderRow[]>(
      db
        .prepare(
          `SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value
           FROM composerHeaders
           WHERE COALESCE(recency, lastUpdatedAt, createdAt, 0) >= ?
           ORDER BY COALESCE(recency, lastUpdatedAt, createdAt, 0) ASC`,
        )
        .all(Number.isFinite(since) ? since : 0),
    );

    let parseFailures = 0;
    let maxRecency = Number.isFinite(since) ? since : 0;
    const bubbles = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?`);

    for (const header of headers) {
      const recency = Number(header.recency ?? header.lastUpdatedAt ?? header.createdAt ?? 0);
      maxRecency = Math.max(maxRecency, recency);
      let value: Record<string, unknown> = {};
      try {
        value = header.value ? (JSON.parse(header.value) as Record<string, unknown>) : {};
      } catch {
        parseFailures += 1;
      }
      const workspace = asRecord(value.workspaceIdentifier);
      const uri = asRecord(workspace?.uri);
      const cwd = asString(uri?.fsPath) ?? asString(uri?.path) ?? null;
      const repos = Array.isArray(value.trackedGitRepos) ? value.trackedGitRepos : [];
      const session: SessionRecord = {
        id: `cursor:${header.composerId}`,
        harness: "cursor",
        nativeId: header.composerId,
        cwd,
        gitBranch: firstRepoBranch(repos),
        worktree: asBool(value.isWorktree),
        title: asString(value.name) ?? asString(value.subtitle),
        startedAt: isoFromMs(header.createdAt),
        endedAt: header.isArchived ? isoFromMs(header.lastUpdatedAt ?? header.recency) : null,
        lastTs: isoFromMs(header.lastUpdatedAt ?? header.recency) ?? isoFromMs(header.createdAt),
        state: "unknown",
        hasBlocking: false,
        isSidechain: header.isSubagent === 1,
      };

      const batch = emptyBatch();
      batch.sessions.push(session);
      const [low, high] = keyRange(`bubbleId:${header.composerId}:`);
      for (const bubble of bubbles.iterate(low, high) as Iterable<{ key: string; value: unknown }>) {
        try {
          const turn = bubbleToTurn(session.id, bubble.key, decodeBlob(bubble.value), session.isSidechain);
          if (!turn) {
            continue;
          }
          batch.turns.push(turn);
          if (turn.tokensIn || turn.tokensOut) {
            batch.usage.push({
              sessionId: turn.sessionId,
              turnId: turn.id,
              sourceEventId: turn.sourceEventId,
              harness: "cursor",
              ts: turn.ts,
              model: turn.model,
              tokensIn: turn.tokensIn,
              tokensOut: turn.tokensOut,
              cacheRead: turn.cacheRead,
              cacheWrite: turn.cacheWrite,
            });
          }
        } catch {
          parseFailures += 1;
        }
      }

      const latest = batch.turns.reduce((max, turn) => (turn.ts > max ? turn.ts : max), "");
      if (latest) {
        session.lastTs = latest;
      }
      onBatch(batch);
    }

    return {
      watermark: String(maxRecency),
      parseFailures,
      unavailable: false,
    };
  } catch (error) {
    return {
      watermark: watermark ?? "0",
      parseFailures: 0,
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

// Half-open key range for a prefix, so SQLite scans the unique index instead of every row.
function keyRange(prefix: string): [string, string] {
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`];
}

interface CursorHeaderRow {
  composerId: string;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: number | null;
  isSubagent: number | null;
  recency: number | null;
  value: string | null;
}

function decodeBlob(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  if (value instanceof Uint8Array) {
    return JSON.parse(Buffer.from(value).toString("utf8")) as Record<string, unknown>;
  }
  throw new Error("unsupported cursor blob");
}

function bubbleToTurn(
  sessionId: string,
  key: string,
  parsed: Record<string, unknown>,
  isSidechain: boolean,
): TurnRecord | null {
  const type = asNumber(parsed.type);
  const role = type === 1 ? "user" : type === 2 ? "assistant" : null;
  if (!role) {
    return null;
  }
  const bubbleId = asString(parsed.bubbleId) ?? key.split(":").at(-1) ?? key;
  const tokenCount = asRecord(parsed.tokenCount);
  const modelInfo = asRecord(parsed.modelInfo);
  const createdAt = bubbleTimestamp(parsed);
  return {
    id: `cursor:${bubbleId}`,
    sessionId,
    sourceEventId: key,
    role,
    ts: createdAt,
    model: asString(modelInfo?.modelName),
    text: truncateText(extractText(parsed.text ?? parsed.richText)),
    tokensIn: asNumber(tokenCount?.inputTokens),
    tokensOut: asNumber(tokenCount?.outputTokens),
    cacheRead: 0,
    cacheWrite: 0,
    stopReason: null,
    permissionMode: null,
    preventedContinuation: false,
    isSidechain,
    interrupted: false,
    cursorRulesJson: parsed.cursorRules ? JSON.stringify(parsed.cursorRules) : null,
    parentId: null,
    isUserPrompt: role === "user",
  };
}

function bubbleTimestamp(parsed: Record<string, unknown>): string {
  const raw = parsed.createdAt ?? parsed.timestamp ?? parsed.created_at;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(raw.trim()) && numeric > 0) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      return new Date(ms).toISOString();
    }
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms > 0) {
      return new Date(ms).toISOString();
    }
  }
  return new Date(0).toISOString();
}

function isoFromMs(value: number | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString();
}

function firstRepoBranch(repos: unknown[]): string | null {
  for (const repo of repos) {
    const rec = asRecord(repo);
    const branch = asString(rec?.branch) ?? asString(rec?.currentBranch);
    if (branch) {
      return branch;
    }
  }
  return null;
}
