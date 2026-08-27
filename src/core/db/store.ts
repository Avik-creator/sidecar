import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";
import type {
  CandidateRecord,
  ClusterRecord,
  Harness,
  IntegrationHealth,
  SessionRecord,
  SuggestionRecord,
  SuggestionStatus,
  TurnRecord,
  UsageEventRecord,
} from "../../shared/types.js";

function asRows<T>(value: unknown): T {
  return value as T;
}

function openDatabase(filePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(filePath: string): Store {
    return new Store(openDatabase(filePath));
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSourceFile(filePath: string): SourceFileState | undefined {
    const row = asRows<SourceFileRow | undefined>(
      this.db
        .prepare(
          `SELECT path, harness, inode, size, mtime_ms, byte_offset, parser_version, watermark
           FROM source_file WHERE path = ?`,
        )
        .get(filePath),
    );
    return row ? mapSourceFile(row) : undefined;
  }

  upsertSourceFile(state: SourceFileState): void {
    this.db
      .prepare(
        `INSERT INTO source_file(path, harness, inode, size, mtime_ms, byte_offset, parser_version, watermark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           harness = excluded.harness,
           inode = excluded.inode,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           byte_offset = excluded.byte_offset,
           parser_version = excluded.parser_version,
           watermark = excluded.watermark`,
      )
      .run(
        state.path,
        state.harness,
        state.inode,
        state.size,
        state.mtimeMs,
        state.byteOffset,
        state.parserVersion,
        state.watermark,
      );
  }

  upsertSession(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO session(id, harness, native_id, cwd, git_branch, worktree, title, started_at, ended_at, last_ts, state, has_blocking, is_sidechain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = COALESCE(excluded.cwd, session.cwd),
           git_branch = COALESCE(excluded.git_branch, session.git_branch),
           worktree = excluded.worktree,
           title = COALESCE(excluded.title, session.title),
           started_at = COALESCE(session.started_at, excluded.started_at),
           ended_at = COALESCE(excluded.ended_at, session.ended_at),
           last_ts = CASE
             WHEN excluded.state = 'unknown' THEN session.last_ts
             WHEN excluded.last_ts IS NOT NULL AND (session.last_ts IS NULL OR excluded.last_ts > session.last_ts)
             THEN excluded.last_ts ELSE session.last_ts END,
           state = CASE
             WHEN excluded.state = 'unknown' THEN session.state
             ELSE excluded.state END,
           has_blocking = CASE
             WHEN excluded.state = 'unknown' THEN session.has_blocking
             ELSE excluded.has_blocking END,
           is_sidechain = excluded.is_sidechain`,
      )
      .run(
        session.id,
        session.harness,
        session.nativeId,
        session.cwd,
        session.gitBranch,
        session.worktree ? 1 : 0,
        session.title,
        session.startedAt,
        session.endedAt,
        session.lastTs,
        session.state,
        session.hasBlocking ? 1 : 0,
        session.isSidechain ? 1 : 0,
      );
  }

  insertTurn(turn: TurnRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO turn(
           id, session_id, source_event_id, role, ts, model, text,
           tokens_in, tokens_out, cache_read, cache_write,
           stop_reason, permission_mode, prevented_continuation,
           is_sidechain, interrupted, cursor_rules_json, parent_id, is_user_prompt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.sessionId,
        turn.sourceEventId,
        turn.role,
        turn.ts,
        turn.model,
        turn.text,
        turn.tokensIn,
        turn.tokensOut,
        turn.cacheRead,
        turn.cacheWrite,
        turn.stopReason,
        turn.permissionMode,
        turn.preventedContinuation ? 1 : 0,
        turn.isSidechain ? 1 : 0,
        turn.interrupted ? 1 : 0,
        turn.cursorRulesJson,
        turn.parentId,
        turn.isUserPrompt ? 1 : 0,
      );
    return Number(result.changes) > 0;
  }

  insertUsage(event: UsageEventRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_event(
           session_id, turn_id, source_event_id, harness, ts, model,
           tokens_in, tokens_out, cache_read, cache_write
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionId,
        event.turnId,
        event.sourceEventId,
        event.harness,
        event.ts,
        event.model,
        event.tokensIn,
        event.tokensOut,
        event.cacheRead,
        event.cacheWrite,
      );
    return Number(result.changes) > 0;
  }

  insertEvent(event: {
    sessionId: string | null;
    harness: Harness;
    type: string;
    ts: string;
    payloadJson: string;
    sourceEventId: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event(session_id, harness, type, ts, payload_json, source_event_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionId,
        event.harness,
        event.type,
        event.ts,
        event.payloadJson,
        event.sourceEventId,
      );
  }

  replaceCandidates(rows: Array<{ turnId: string; signals: string[]; score: number; createdAt: string }>): void {
    this.db.exec("DELETE FROM candidate");
    const stmt = this.db.prepare(
      `INSERT INTO candidate(turn_id, signals_json, score, created_at) VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows) {
      stmt.run(row.turnId, JSON.stringify(row.signals), row.score, row.createdAt);
    }
  }

  upsertCluster(cluster: ClusterRecord): void {
    this.db
      .prepare(
        `INSERT INTO cluster(id, label, canonical_key, count, distinct_sessions, distinct_tasks, status, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           count = excluded.count,
           distinct_sessions = excluded.distinct_sessions,
           distinct_tasks = excluded.distinct_tasks,
           status = excluded.status,
           version = excluded.version`,
      )
      .run(
        cluster.id,
        cluster.label,
        cluster.canonicalKey,
        cluster.count,
        cluster.distinctSessions,
        cluster.distinctTasks,
        cluster.status,
        cluster.version,
      );
  }

  replaceMemberships(clusterId: string, version: number, members: Array<{ turnId: string; sessionId: string }>): void {
    this.db.prepare(`DELETE FROM cluster_membership WHERE cluster_id = ?`).run(clusterId);
    const stmt = this.db.prepare(
      `INSERT INTO cluster_membership(cluster_id, turn_id, session_id, version) VALUES (?, ?, ?, ?)`,
    );
    for (const member of members) {
      stmt.run(clusterId, member.turnId, member.sessionId, version);
    }
  }

  insertSuggestion(row: SuggestionRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO suggestion(
           id, cluster_id, target_file, diff, rationale, status, base_hash,
           created_at, applied_at, backup_path, applied_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.clusterId,
        row.targetFile,
        row.diff,
        row.rationale,
        row.status,
        row.baseHash,
        row.createdAt,
        row.appliedAt,
        row.backupPath,
        row.appliedHash,
      );
  }

  updateSuggestion(
    id: string,
    patch: Partial<Pick<SuggestionRecord, "status" | "appliedAt" | "backupPath" | "appliedHash" | "baseHash">>,
  ): void {
    const current = this.getSuggestion(id);
    if (!current) {
      throw new Error(`unknown suggestion ${id}`);
    }
    const next: SuggestionRecord = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE suggestion
         SET status = ?, applied_at = ?, backup_path = ?, applied_hash = ?, base_hash = ?
         WHERE id = ?`,
      )
      .run(next.status, next.appliedAt, next.backupPath, next.appliedHash, next.baseHash, id);
  }

  setHealth(row: IntegrationHealth): void {
    this.db
      .prepare(
        `INSERT INTO integration_health(harness, status, last_ok_at, lag_ms, parse_failures, last_error)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(harness) DO UPDATE SET
           status = excluded.status,
           last_ok_at = excluded.last_ok_at,
           lag_ms = excluded.lag_ms,
           parse_failures = excluded.parse_failures,
           last_error = excluded.last_error`,
      )
      .run(row.harness, row.status, row.lastOkAt, row.lagMs, row.parseFailures, row.lastError);
  }

  listSessions(limit = 200): SessionRecord[] {
    const rows = asRows<SessionRow[]>(
      this.db
        .prepare(
          `SELECT s.*,
                  (
                    SELECT t.text FROM turn t
                    WHERE t.session_id = s.id AND t.is_user_prompt = 1
                    ORDER BY t.ts DESC LIMIT 1
                  ) AS last_text,
                  (
                    SELECT t.role FROM turn t
                    WHERE t.session_id = s.id AND t.role IN ('user', 'assistant')
                    ORDER BY t.ts DESC LIMIT 1
                  ) AS last_role,
                  s.harness = 'claude' AND s.has_blocking = 1 AND EXISTS (
                    SELECT 1 FROM event e
                    WHERE e.session_id = s.id
                      AND e.type = 'PermissionRequest'
                      AND e.ts > COALESCE((
                        SELECT MAX(t.ts) FROM turn t
                        WHERE t.session_id = s.id
                      ), '')
                  ) AS pending_permission
           FROM session s
           ORDER BY COALESCE(s.last_ts, s.started_at) DESC
           LIMIT ?`,
        )
        .all(limit),
    );
    return rows.map(mapSession);
  }

  listTurnsForPrefilter(): TurnRecord[] {
    const rows = asRows<TurnRow[]>(
      this.db.prepare(`SELECT * FROM turn WHERE role IN ('user', 'assistant') ORDER BY session_id, ts`).all(),
    );
    return rows.map(mapTurn);
  }

  listCandidates(limit = 200): CandidateRecord[] {
    const rows = asRows<CandidateJoinRow[]>(
      this.db
        .prepare(
          `SELECT c.turn_id, c.signals_json, c.score, t.session_id, t.ts, t.text, s.harness, s.cwd
           FROM candidate c
           JOIN turn t ON t.id = c.turn_id
           JOIN session s ON s.id = t.session_id
           ORDER BY c.score DESC, t.ts DESC
           LIMIT ?`,
        )
        .all(limit),
    );
    return rows.map((row) => ({
      turnId: row.turn_id,
      sessionId: row.session_id,
      harness: row.harness as Harness,
      ts: row.ts,
      text: row.text.length > 400 ? `${row.text.slice(0, 400)}…` : row.text,
      signals: JSON.parse(row.signals_json) as string[],
      score: row.score,
      cwd: row.cwd,
    }));
  }

  listClusters(): ClusterRecord[] {
    const rows = asRows<ClusterRow[]>(this.db.prepare(`SELECT * FROM cluster ORDER BY distinct_sessions DESC, count DESC`).all());
    return rows.map(mapCluster);
  }

  listSuggestions(): SuggestionRecord[] {
    const rows = asRows<SuggestionRow[]>(this.db.prepare(`SELECT * FROM suggestion ORDER BY created_at DESC`).all());
    return rows.map(mapSuggestion);
  }

  getSuggestion(id: string): SuggestionRecord | undefined {
    const row = asRows<SuggestionRow | undefined>(this.db.prepare(`SELECT * FROM suggestion WHERE id = ?`).get(id));
    return row ? mapSuggestion(row) : undefined;
  }

  listHealth(): IntegrationHealth[] {
    const rows = asRows<HealthRow[]>(this.db.prepare(`SELECT * FROM integration_health`).all());
    return rows.map((row) => ({
      harness: row.harness as Harness,
      status: row.status as IntegrationHealth["status"],
      lastOkAt: row.last_ok_at,
      lagMs: row.lag_ms,
      parseFailures: row.parse_failures,
      lastError: row.last_error,
    }));
  }

  counts(): { sessions: number; turns: number; candidates: number; suggestions: number } {
    const sessions = asRows<{ n: number }>(this.db.prepare(`SELECT COUNT(*) AS n FROM session`).get()).n;
    const turns = asRows<{ n: number }>(this.db.prepare(`SELECT COUNT(*) AS n FROM turn`).get()).n;
    const candidates = asRows<{ n: number }>(this.db.prepare(`SELECT COUNT(*) AS n FROM candidate`).get()).n;
    const suggestions = asRows<{ n: number }>(this.db.prepare(`SELECT COUNT(*) AS n FROM suggestion`).get()).n;
    return { sessions, turns, candidates, suggestions };
  }

  usageRows(): Array<{
    ts: string;
    harness: Harness;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
  }> {
    const rows = asRows<UsageRow[]>(
      this.db.prepare(`SELECT ts, harness, model, tokens_in, tokens_out, cache_read, cache_write FROM usage_event`).all(),
    );
    return rows.map((row) => ({
      ts: row.ts,
      harness: row.harness as Harness,
      model: row.model,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
    }));
  }

  clusterMembers(clusterId: string): Array<{ turnId: string; sessionId: string; cwd: string | null; text: string; ts: string }> {
    const rows = asRows<MemberRow[]>(
      this.db
        .prepare(
          `SELECT m.turn_id, m.session_id, s.cwd, t.text, t.ts
           FROM cluster_membership m
           JOIN turn t ON t.id = m.turn_id
           JOIN session s ON s.id = m.session_id
           WHERE m.cluster_id = ?`,
        )
        .all(clusterId),
    );
    return rows.map((row) => ({
      turnId: row.turn_id,
      sessionId: row.session_id,
      cwd: row.cwd,
      text: row.text,
      ts: row.ts,
    }));
  }
}

export interface SourceFileState {
  path: string;
  harness: Harness;
  inode: string | null;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  parserVersion: number;
  watermark: string | null;
}

interface SourceFileRow {
  path: string;
  harness: string;
  inode: string | null;
  size: number;
  mtime_ms: number;
  byte_offset: number;
  parser_version: number;
  watermark: string | null;
}

interface SessionRow {
  id: string;
  harness: string;
  native_id: string;
  cwd: string | null;
  git_branch: string | null;
  worktree: number;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_ts: string | null;
  state: string;
  has_blocking: number;
  is_sidechain: number;
  last_text?: string | null;
  last_role?: string | null;
  pending_permission?: number;
}

interface TurnRow {
  id: string;
  session_id: string;
  source_event_id: string;
  role: string;
  ts: string;
  model: string | null;
  text: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  stop_reason: string | null;
  permission_mode: string | null;
  prevented_continuation: number;
  is_sidechain: number;
  interrupted: number;
  cursor_rules_json: string | null;
  parent_id: string | null;
  is_user_prompt: number;
}

interface CandidateJoinRow {
  turn_id: string;
  signals_json: string;
  score: number;
  session_id: string;
  ts: string;
  text: string;
  harness: string;
  cwd: string | null;
}

interface ClusterRow {
  id: string;
  label: string;
  canonical_key: string;
  count: number;
  distinct_sessions: number;
  distinct_tasks: number;
  status: string;
  version: number;
}

interface SuggestionRow {
  id: string;
  cluster_id: string;
  target_file: string;
  diff: string;
  rationale: string | null;
  status: string;
  base_hash: string | null;
  created_at: string;
  applied_at: string | null;
  backup_path: string | null;
  applied_hash: string | null;
}

interface HealthRow {
  harness: string;
  status: string;
  last_ok_at: string | null;
  lag_ms: number | null;
  parse_failures: number;
  last_error: string | null;
}

interface UsageRow {
  ts: string;
  harness: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
}

interface MemberRow {
  turn_id: string;
  session_id: string;
  cwd: string | null;
  text: string;
  ts: string;
}

function mapSourceFile(row: SourceFileRow): SourceFileState {
  return {
    path: row.path,
    harness: row.harness as Harness,
    inode: row.inode,
    size: row.size,
    mtimeMs: row.mtime_ms,
    byteOffset: row.byte_offset,
    parserVersion: row.parser_version,
    watermark: row.watermark,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  const hasBlocking =
    row.harness === "claude" ? row.pending_permission === 1 : row.has_blocking === 1;
  const state =
    row.harness === "claude" && row.state === "needs_attention" && !hasBlocking
      ? "unknown"
      : row.state as SessionRecord["state"];
  return {
    id: row.id,
    harness: row.harness as Harness,
    nativeId: row.native_id,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    worktree: row.worktree === 1,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastTs: row.last_ts,
    state,
    hasBlocking,
    isSidechain: row.is_sidechain === 1,
    activity: firstActivity(row.title, row.last_text, row.cwd),
    lastRole: row.last_role === "user" || row.last_role === "assistant" ? row.last_role : null,
  };
}

function firstActivity(title: string | null, lastText: string | null | undefined, cwd: string | null): string | null {
  const fromTitle = title?.trim();
  if (fromTitle && fromTitle.toLowerCase() !== "new chat") {
    return fromTitle;
  }
  const fromText = lastText?.trim().split(/\r?\n/).find((line) => line.trim().length > 0);
  if (fromText && !fromText.startsWith("<") && !fromText.startsWith("{")) {
    return fromText.replace(/^#+\s*/, "").slice(0, 90);
  }
  if (cwd) {
    return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
  }
  return null;
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceEventId: row.source_event_id,
    role: row.role as TurnRecord["role"],
    ts: row.ts,
    model: row.model,
    text: row.text,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    stopReason: row.stop_reason,
    permissionMode: row.permission_mode,
    preventedContinuation: row.prevented_continuation === 1,
    isSidechain: row.is_sidechain === 1,
    interrupted: row.interrupted === 1,
    cursorRulesJson: row.cursor_rules_json,
    parentId: row.parent_id,
    isUserPrompt: row.is_user_prompt === 1,
  };
}

function mapCluster(row: ClusterRow): ClusterRecord {
  return {
    id: row.id,
    label: row.label,
    canonicalKey: row.canonical_key,
    count: row.count,
    distinctSessions: row.distinct_sessions,
    distinctTasks: row.distinct_tasks,
    status: row.status as ClusterRecord["status"],
    version: row.version,
  };
}

function mapSuggestion(row: SuggestionRow): SuggestionRecord {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    targetFile: row.target_file,
    diff: row.diff,
    rationale: row.rationale,
    status: row.status as SuggestionStatus,
    baseHash: row.base_hash,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    backupPath: row.backup_path,
    appliedHash: row.applied_hash,
  };
}

