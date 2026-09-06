import fs from "node:fs";
import path from "node:path";
import { PARSER_VERSION } from "../constants.js";
import { Store } from "../db/store.js";
import { parseClaudeLine, emptyBatch, foldSessions, mergeBatch, type ParsedBatch } from "./claude.js";
import { idFromFilename, parseCodexLine } from "./codex.js";
import { ingestCursor } from "./cursor.js";
import { fileIdentity, readJsonlFromOffset, resumeOffset, nextSourceState } from "./jsonl.js";
import {
  claudeProjectsDir,
  codexSessionsDir,
  cursorStateDb,
  hooksSpoolDir,
} from "../paths.js";
import {
  agentIdFromPayload,
  agentTypeFromPayload,
  cwdFromPayload,
  hookOutcome,
  outcomeForSubagent,
  sessionIdFromPayload,
} from "../hooks/events.js";
import { clearSpool, readSpool } from "../hooks/spool.js";
import type { Harness, IngestReport } from "../../shared/types.js";

// Parsed rows are written in batches so one huge transcript never sits in memory whole.
const FLUSH_TURNS = 2000;

export interface IngestOptions {
  claudeDir?: string;
  codexDir?: string;
  cursorDb?: string;
  spoolDir?: string;
}

export function ingestAll(store: Store, options: IngestOptions = {}): IngestReport {
  const started = Date.now();
  let filesSeen = 0;
  let recordsRead = 0;
  let turnsUpserted = 0;
  let usageEvents = 0;
  let parseFailures = 0;

  const claudeDir = options.claudeDir ?? claudeProjectsDir();
  const codexDir = options.codexDir ?? codexSessionsDir();
  const cursorDb = options.cursorDb ?? cursorStateDb();
  const spoolDir = options.spoolDir ?? hooksSpoolDir();

  const claudeFiles = listJsonl(claudeDir);
  filesSeen += claudeFiles.length;
  let claudeFailures = 0;
  let claudeError: string | null = null;
  for (const filePath of claudeFiles) {
    try {
      const result = ingestJsonlFile(store, filePath, "claude", (line) => parseClaudeLine(filePath, line));
      recordsRead += result.recordsRead;
      turnsUpserted += result.turnsUpserted;
      usageEvents += result.usageEvents;
      claudeFailures += result.parseFailures;
    } catch (error) {
      claudeFailures += 1;
      if (!isPermissionError(error)) {
        claudeError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  parseFailures += claudeFailures;
  store.setHealth({
    harness: "claude",
    status: claudeError ? "degraded" : "ok",
    lastOkAt: new Date().toISOString(),
    lagMs: 0,
    parseFailures: claudeFailures,
    lastError: claudeError,
  });

  const codexFiles = listJsonl(codexDir);
  filesSeen += codexFiles.length;
  let codexFailures = 0;
  let codexError: string | null = null;
  for (const filePath of codexFiles) {
    try {
      const hint = idFromFilename(filePath);
      const result = ingestJsonlFile(store, filePath, "codex", (line) => parseCodexLine(filePath, line, hint));
      recordsRead += result.recordsRead;
      turnsUpserted += result.turnsUpserted;
      usageEvents += result.usageEvents;
      codexFailures += result.parseFailures;
    } catch (error) {
      codexFailures += 1;
      if (!isPermissionError(error)) {
        codexError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  parseFailures += codexFailures;
  store.setHealth({
    harness: "codex",
    status: codexError ? "degraded" : "ok",
    lastOkAt: new Date().toISOString(),
    lagMs: 0,
    parseFailures: codexFailures,
    lastError: codexError,
  });

  if (fs.existsSync(cursorDb)) {
    filesSeen += 1;
    const previous = store.getSourceFile(cursorDb);
    let cursorTurns = 0;
    let cursorUsage = 0;
    let cursorRecords = 0;
    const result = ingestCursor(cursorDb, previous?.watermark ?? "0", (batch) => {
      const counts = persistBatch(store, batch);
      cursorTurns += counts.turns;
      cursorUsage += counts.usage;
      cursorRecords += batch.turns.length + batch.sessions.length;
    });
    parseFailures += result.parseFailures;
    if (result.unavailable) {
      store.setHealth({
        harness: "cursor",
        status: "unavailable",
        lastOkAt: previous ? new Date().toISOString() : null,
        lagMs: null,
        parseFailures: result.parseFailures,
        lastError: result.error ?? "Cursor database unavailable",
      });
    } else {
      turnsUpserted += cursorTurns;
      usageEvents += cursorUsage;
      recordsRead += cursorRecords;
      const identity = fileIdentity(cursorDb);
      if (identity) {
        store.upsertSourceFile(nextSourceState(cursorDb, "cursor", identity, 0, result.watermark));
      }
      store.setHealth({
        harness: "cursor",
        status: "ok",
        lastOkAt: new Date().toISOString(),
        lagMs: 0,
        parseFailures: result.parseFailures,
        lastError: null,
      });
    }
  } else {
    store.setHealth({
      harness: "cursor",
      status: "unavailable",
      lastOkAt: null,
      lagMs: null,
      parseFailures: 0,
      lastError: "state.vscdb not found",
    });
  }

  const spool = readSpool(spoolDir);
  filesSeen += spool.files.length;
  recordsRead += spool.events.length;
  parseFailures += spool.failures;
  if (spool.events.length > 0) {
    store.transaction(() => {
      for (const event of spool.events) {
        const base = hookOutcome(event.harness, event.type);
        const sessionNativeId = sessionIdFromPayload(event.harness, event.payload);
        if (!base || !sessionNativeId) {
          continue;
        }
        // Events fired inside a subagent carry its id, so they land on the subagent's own row.
        const agentId = agentIdFromPayload(event.payload);
        const outcome = agentId ? outcomeForSubagent(base) : base;
        const nativeId = agentId ? `${sessionNativeId}:${agentId}` : sessionNativeId;
        store.applyHookState({
          sessionId: `${event.harness}:${nativeId}`,
          harness: event.harness,
          nativeId,
          cwd: cwdFromPayload(event.harness, event.payload),
          state: outcome.state,
          hasBlocking: outcome.hasBlocking,
          ts: event.ts,
          eventType: event.type,
          parentId: agentId ? `${event.harness}:${sessionNativeId}` : null,
          agentType: agentId ? agentTypeFromPayload(event.payload) : null,
        });
      }
    });
  }
  clearSpool(spool.files);

  return {
    filesSeen,
    recordsRead,
    turnsUpserted,
    usageEvents,
    parseFailures,
    durationMs: Date.now() - started,
  };
}

function ingestJsonlFile(
  store: Store,
  filePath: string,
  harness: Harness,
  parse: (line: string) => ParsedBatch | "skip" | "fail",
): { recordsRead: number; turnsUpserted: number; usageEvents: number; parseFailures: number } {
  const identity = fileIdentity(filePath);
  if (!identity) {
    return { recordsRead: 0, turnsUpserted: 0, usageEvents: 0, parseFailures: 0 };
  }
  const previous = store.getSourceFile(filePath);
  const start = resumeOffset(previous, identity);
  if (start === identity.size && previous?.parserVersion === PARSER_VERSION) {
    store.upsertSourceFile(nextSourceState(filePath, harness, identity, start, previous.watermark));
    return { recordsRead: 0, turnsUpserted: 0, usageEvents: 0, parseFailures: 0 };
  }
  let turnsUpserted = 0;
  let usageEvents = 0;
  let parseFailures = 0;
  let recordsRead = 0;
  let combined = emptyBatch();
  const flush = (): void => {
    const counts = persistBatch(store, combined);
    turnsUpserted += counts.turns;
    usageEvents += counts.usage;
    combined = emptyBatch();
  };
  const { nextOffset, failures } = readJsonlFromOffset(filePath, start, (text) => {
    recordsRead += 1;
    const parsed = parse(text);
    if (parsed === "skip") {
      return;
    }
    if (parsed === "fail") {
      parseFailures += 1;
      return;
    }
    mergeBatch(combined, parsed);
    if (combined.turns.length >= FLUSH_TURNS) {
      flush();
    }
  });
  flush();
  store.upsertSourceFile(nextSourceState(filePath, harness, identity, nextOffset, previous?.watermark ?? null));
  return {
    recordsRead,
    turnsUpserted,
    usageEvents,
    parseFailures: parseFailures + failures,
  };
}

function persistBatch(store: Store, batch: ParsedBatch): { turns: number; usage: number } {
  let turns = 0;
  let usage = 0;
  store.transaction(() => {
    for (const session of foldSessions(batch.sessions)) {
      store.upsertSession(session);
    }
    for (const turn of batch.turns) {
      if (store.insertTurn(turn)) {
        turns += 1;
      }
    }
    for (const event of batch.usage) {
      if (store.insertUsage(event)) {
        usage += 1;
      }
    }
  });
  return { turns, usage };
}

function listJsonl(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}
