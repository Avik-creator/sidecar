import { DatabaseSync } from "node:sqlite";
import type { ParsedBatch } from "./claude.js";
import { emptyBatch } from "./claude.js";
import { asBool, asNumber, asRecord, asString, extractText, truncateText } from "../text.js";
import type { SessionRecord, TurnRecord } from "../../shared/types.js";

function asRows<T>(value: unknown): T {
  return value as T;
}

export interface CursorIngestResult {
  batch: ParsedBatch;
  watermark: string;
  parseFailures: number;
  unavailable: boolean;
  error?: string;
}

export function ingestCursor(dbPath: string, watermark: string | null): CursorIngestResult {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return {
      batch: emptyBatch(),
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
          `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value
           FROM composerHeaders
           WHERE COALESCE(recency, lastUpdatedAt, createdAt, 0) >= ?
           ORDER BY COALESCE(recency, lastUpdatedAt, createdAt, 0) ASC`,
        )
        .all(Number.isFinite(since) ? since : 0),
    );

    const batch = emptyBatch();
    let parseFailures = 0;
    let maxRecency = Number.isFinite(since) ? since : 0;
    const sessions = new Map<string, SessionRecord>();

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
      const hasBlocking = asBool(value.hasBlockingPendingActions);
      const agentLocation = asRecord(value.agentLocation);
      const agentStatus = asString(agentLocation?.status);
      const isRunning = value.unfinishedRunAt != null || agentStatus === "active" || agentStatus === "running";
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
        lastTs: isoFromMs(header.lastUpdatedAt ?? header.recency ?? header.createdAt),
        state: hasBlocking
          ? "needs_attention"
          : !header.isArchived && isRunning
            ? "active"
            : "ended",
        hasBlocking,
        isSidechain: header.isSubagent === 1,
      };
      sessions.set(header.composerId, session);
      batch.sessions.push(session);
    }

    const bubbles = loadBubbles(db, headers);
    for (const bubble of bubbles) {
      const composerId = bubble.key.split(":")[1];
      if (!composerId || !sessions.has(composerId)) {
        continue;
      }
      try {
        const parsed = decodeBlob(bubble.value);
        const turn = bubbleToTurn(
          `cursor:${composerId}`,
          bubble.key,
          parsed,
          sessions.get(composerId)?.isSidechain ?? false,
        );
        if (turn) {
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
        }
      } catch {
        parseFailures += 1;
      }
    }

    return {
      batch,
      watermark: String(maxRecency),
      parseFailures,
      unavailable: false,
    };
  } catch (error) {
    return {
      batch: emptyBatch(),
      watermark: watermark ?? "0",
      parseFailures: 0,
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

interface CursorHeaderRow {
  composerId: string;
  workspaceId: string | null;
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
  if (Buffer.isBuffer(value)) {
    return JSON.parse(value.toString("utf8")) as Record<string, unknown>;
  }
  throw new Error("unsupported cursor blob");
}

function loadBubbles(db: DatabaseSync, headers: CursorHeaderRow[]): Array<{ key: string; value: unknown }> {
  if (headers.length === 0) {
    return [];
  }
  if (headers.length > 16) {
    return asRows<Array<{ key: string; value: unknown }>>(
      db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'`).all(),
    );
  }
  const statement = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ?`);
  const rows: Array<{ key: string; value: unknown }> = [];
  for (const header of headers) {
    rows.push(...asRows<Array<{ key: string; value: unknown }>>(statement.all(`bubbleId:${header.composerId}:%`)));
  }
  return rows;
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
  const createdAt = asString(parsed.createdAt) ?? new Date(0).toISOString();
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
