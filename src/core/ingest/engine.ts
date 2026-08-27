import fs from "node:fs";
import path from "node:path";
import { PARSER_VERSION } from "../constants.js";
import { Store } from "../db/store.js";
import { parseClaudeLine, emptyBatch, mergeBatch, type ParsedBatch } from "./claude.js";
import { idFromFilename, parseCodexLine } from "./codex.js";
import { ingestCursor } from "./cursor.js";
import { fileIdentity, readJsonlFromOffset, resumeOffset, nextSourceState } from "./jsonl.js";
import {
  claudeProjectsDir,
  codexSessionsDir,
  cursorStateDb,
  hooksLogPath,
} from "../paths.js";
import type { Harness, IngestReport } from "../../shared/types.js";

export interface IngestOptions {
  claudeDir?: string;
  codexDir?: string;
  cursorDb?: string;
  hooksFile?: string;
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
  const hooksFile = options.hooksFile ?? hooksLogPath();

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
    const result = ingestCursor(cursorDb, previous?.watermark ?? "0");
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
      const counts = persistBatch(store, result.batch);
      turnsUpserted += counts.turns;
      usageEvents += counts.usage;
      recordsRead += result.batch.turns.length + result.batch.sessions.length;
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

  if (fs.existsSync(hooksFile)) {
    filesSeen += 1;
    const result = ingestJsonlFile(store, hooksFile, "claude", (line) => parseHookLine(line));
    recordsRead += result.recordsRead;
    parseFailures += result.parseFailures;
  }

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
  const { lines, nextOffset, failures } = readJsonlFromOffset(filePath, start);
  let turnsUpserted = 0;
  let usageEvents = 0;
  let parseFailures = failures;
  const combined = emptyBatch();
  for (const line of lines) {
    const parsed = parse(line.text);
    if (parsed === "skip") {
      continue;
    }
    if (parsed === "fail") {
      parseFailures += 1;
      continue;
    }
    mergeBatch(combined, parsed);
  }
  const counts = persistBatch(store, combined);
  turnsUpserted += counts.turns;
  usageEvents += counts.usage;
  store.upsertSourceFile(nextSourceState(filePath, harness, identity, nextOffset, previous?.watermark ?? null));
  return {
    recordsRead: lines.length,
    turnsUpserted,
    usageEvents,
    parseFailures,
  };
}

function persistBatch(store: Store, batch: ParsedBatch): { turns: number; usage: number } {
  let turns = 0;
  let usage = 0;
  store.transaction(() => {
    for (const session of batch.sessions) {
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
    for (const event of batch.events) {
      store.insertEvent(event);
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

function parseHookLine(line: string): ParsedBatch | "skip" | "fail" {
  try {
    const rec = JSON.parse(line) as Record<string, unknown>;
    const harness = (rec.harness as Harness | undefined) ?? "claude";
    const sessionId = typeof rec.sessionId === "string" ? `${harness}:${rec.sessionId}` : null;
    const ts = typeof rec.ts === "string" ? rec.ts : new Date().toISOString();
    const type = typeof rec.type === "string" ? rec.type : "hook";
    const batch = emptyBatch();
    batch.events.push({
      sessionId,
      harness,
      type,
      ts,
      payloadJson: JSON.stringify(rec.payload ?? rec),
      sourceEventId: typeof rec.id === "string" ? rec.id : `${type}:${ts}`,
    });
    if (sessionId && type === "PermissionRequest") {
      batch.sessions.push({
        id: sessionId,
        harness,
        nativeId: rec.sessionId as string,
        cwd: null,
        gitBranch: null,
        worktree: false,
        title: null,
        startedAt: ts,
        endedAt: null,
        lastTs: ts,
        state: "needs_attention",
        hasBlocking: true,
        isSidechain: false,
      });
    }
    return batch;
  } catch {
    return "fail";
  }
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}
