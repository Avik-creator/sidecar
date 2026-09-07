import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { asBool, asNumber, asRecord, asString } from "../text.js";
import { ENDED, WORKING, YOUR_TURN, isoFromMs, type NativeState } from "./state.js";

// Conversations older than this are left to their transcript row.
const RECENT_MS = 24 * 60 * 60 * 1000;

interface HeaderRow {
  composerId: string;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  recency: number | null;
  value: string | null;
}

// Reads Cursor's composer records; appAlive null means Sidecar could not tell whether Cursor runs.
export function readCursorComposers(
  dbPath: string,
  appPid: number | null,
  appAlive: boolean | null,
  now = Date.now(),
): NativeState[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 2000");
    const headers = db
      .prepare(
        `SELECT composerId, createdAt, lastUpdatedAt, recency, value FROM composerHeaders
         WHERE COALESCE(recency, lastUpdatedAt, createdAt, 0) >= ?`,
      )
      .all(now - RECENT_MS) as unknown as HeaderRow[];
    const data = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`);
    const out: NativeState[] = [];
    for (const header of headers) {
      const row = data.get(`composerData:${header.composerId}`) as { value: unknown } | undefined;
      const state = toState(header, parseJson(row?.value), appPid, appAlive);
      if (state) {
        out.push(state);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function toState(
  header: HeaderRow,
  composer: Record<string, unknown> | null,
  appPid: number | null,
  appAlive: boolean | null,
): NativeState | null {
  if (!composer) {
    return null;
  }
  const generating =
    (Array.isArray(composer.generatingBubbleIds) && composer.generatingBubbleIds.length > 0) ||
    asBool(composer.isReadingLongFile);
  const unread = asBool(composer.hasUnreadMessages);
  const status = asString(composer.status);
  let outcome: { state: NativeState["state"]; hasBlocking: boolean };
  let eventType: string;
  if (appAlive === false) {
    outcome = ENDED;
    eventType = "app:closed";
  } else if (generating) {
    outcome = WORKING;
    eventType = "composer:generating";
  } else if (unread) {
    outcome = YOUR_TURN;
    eventType = "composer:unread";
  } else if (status === "completed" || status === "aborted") {
    outcome = ENDED;
    eventType = `composer:${status}`;
  } else {
    // "none" means the conversation never ran, so there is nothing to claim.
    return null;
  }
  const headerValue = parseJson(header.value);
  const uri = asRecord(asRecord(headerValue?.workspaceIdentifier)?.uri);
  const parent = asString(asRecord(headerValue?.subagentInfo)?.parentComposerId);
  const ts =
    isoFromMs(
      Math.max(asNumber(composer.lastUpdatedAt), header.lastUpdatedAt ?? 0, header.recency ?? 0, header.createdAt ?? 0),
    ) ?? new Date().toISOString();
  return {
    harness: "cursor",
    nativeId: header.composerId,
    cwd: asString(uri?.fsPath) ?? asString(uri?.path) ?? null,
    title: asString(composer.name) ?? asString(headerValue?.name),
    state: outcome.state,
    hasBlocking: outcome.hasBlocking,
    ts,
    eventType,
    source: "cursor-db",
    pid: appPid,
    parentId: parent ? `cursor:${parent}` : null,
    agentType: asString(asRecord(headerValue?.subagentInfo)?.subagentTypeName),
  };
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}
