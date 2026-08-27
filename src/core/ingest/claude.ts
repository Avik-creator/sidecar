import type { Harness, SessionRecord, TurnRecord, UsageEventRecord } from "../../shared/types.js";
import { asBool, asNumber, asRecord, asString, extractText, truncateText } from "../text.js";

export interface ParsedBatch {
  sessions: SessionRecord[];
  turns: TurnRecord[];
  usage: UsageEventRecord[];
  events: Array<{
    sessionId: string | null;
    harness: Harness;
    type: string;
    ts: string;
    payloadJson: string;
    sourceEventId: string;
  }>;
}

export function emptyBatch(): ParsedBatch {
  return { sessions: [], turns: [], usage: [], events: [] };
}

export function mergeBatch(into: ParsedBatch, extra: ParsedBatch): void {
  into.sessions.push(...extra.sessions);
  into.turns.push(...extra.turns);
  into.usage.push(...extra.usage);
  into.events.push(...extra.events);
}

export function parseClaudeLine(filePath: string, line: string): ParsedBatch | "skip" | "fail" {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return "fail";
  }
  const type = asString(rec.type);
  if (!type) {
    return "fail";
  }

  const sessionId = asString(rec.sessionId) ?? sessionIdFromPath(filePath);
  if (!sessionId) {
    return "skip";
  }
  const id = `claude:${sessionId}`;
  const ts = asString(rec.timestamp) ?? fallbackTs(rec);
  const cwd = asString(rec.cwd);
  const gitBranch = asString(rec.gitBranch);
  const isSidechain = asBool(rec.isSidechain);
  const state = claudeSessionState(rec, type);
  const batch = emptyBatch();

  batch.sessions.push({
    id,
    harness: "claude",
    nativeId: sessionId,
    cwd,
    gitBranch,
    worktree: false,
    title: type === "ai-title" ? asString(rec.aiTitle) : null,
    startedAt: ts,
    endedAt: state === "ended" ? ts : null,
    lastTs: ts,
    state,
    hasBlocking: false,
    isSidechain,
  });

  if (type === "user" || type === "assistant" || type === "system") {
    const message = asRecord(rec.message) ?? rec;
    const uuid = asString(rec.uuid) ?? `${type}:${ts}`;
    const usage = asRecord(asRecord(rec.message)?.usage);
    const role = type === "assistant" ? "assistant" : type === "system" ? "system" : "user";
    const isUserPrompt = type === "user" && isClaudeUserPrompt(rec);
    const text = truncateText(extractText(message.content ?? rec.content ?? rec.lastPrompt));
    const tokensIn = asNumber(usage?.input_tokens);
    const cacheWrite = asNumber(usage?.cache_creation_input_tokens);
    const cacheRead = asNumber(usage?.cache_read_input_tokens);
    const tokensOut = asNumber(usage?.output_tokens);
    const turn: TurnRecord = {
      id: `claude:${uuid}`,
      sessionId: id,
      sourceEventId: uuid,
      role,
      ts,
      model: asString(asRecord(rec.message)?.model),
      text,
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
      stopReason: asString(rec.stopReason) ?? asString(asRecord(rec.message)?.stop_reason),
      permissionMode: asString(rec.permissionMode),
      preventedContinuation: asBool(rec.preventedContinuation),
      isSidechain,
      interrupted: rec.interruptedMessageId != null,
      cursorRulesJson: null,
      parentId: asString(rec.parentUuid),
      isUserPrompt,
    };
    batch.turns.push(turn);
    if (type === "assistant" && (tokensIn || tokensOut || cacheRead || cacheWrite)) {
      batch.usage.push({
        sessionId: id,
        turnId: turn.id,
        sourceEventId: uuid,
        harness: "claude",
        ts,
        model: turn.model,
        tokensIn,
        tokensOut,
        cacheRead,
        cacheWrite,
      });
    }
  }

  if (type === "permission-mode") {
    batch.sessions[0] = {
      ...batch.sessions[0]!,
      hasBlocking: false,
      state: "active",
    };
  }

  if (type !== "user" && type !== "assistant") {
    batch.events.push({
      sessionId: id,
      harness: "claude",
      type,
      ts,
      payloadJson: compactPayload(rec),
      sourceEventId: asString(rec.uuid) ?? `${type}:${ts}`,
    });
  }

  return batch;
}

export function isClaudeUserPrompt(rec: Record<string, unknown>): boolean {
  if (rec.toolUseResult != null) {
    return false;
  }
  if (asBool(rec.isMeta)) {
    return false;
  }
  const message = asRecord(rec.message);
  const content = message?.content;
  if (Array.isArray(content) && content.some((part) => asRecord(part)?.type === "tool_result")) {
    return false;
  }
  const text = extractText(message?.content ?? rec.content);
  if (isSyntheticUserText(text)) {
    return false;
  }
  return true;
}

export function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("This session is being continued from a previous conversation")) {
    return true;
  }
  if (trimmed.startsWith("[Request interrupted by user")) {
    return true;
  }
  if (trimmed.startsWith("# AGENTS.md instructions")) {
    return true;
  }
  if (trimmed.includes("<INSTRUCTIONS>")) {
    return true;
  }
  return false;
}

function sessionIdFromPath(filePath: string): string | null {
  const base = filePath.split("/").at(-1) ?? "";
  if (base.endsWith(".jsonl")) {
    return base.slice(0, -".jsonl".length);
  }
  return null;
}

function fallbackTs(rec: Record<string, unknown>): string {
  return asString(rec.timestamp) ?? new Date(0).toISOString();
}

function claudeSessionState(rec: Record<string, unknown>, type: string): SessionRecord["state"] {
  if (type === "result" || type === "system" && asString(rec.subtype) === "session_end") {
    return "ended";
  }
  if (type === "assistant") {
    const stopReason = asString(rec.stopReason) ?? asString(asRecord(rec.message)?.stop_reason);
    return stopReason ? "ended" : "active";
  }
  if (type === "user") {
    return "active";
  }
  return "unknown";
}

function compactPayload(rec: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (key === "message" || key === "content" || key === "snapshot" || key === "attachment") {
      continue;
    }
    copy[key] = value;
  }
  return JSON.stringify(copy);
}
