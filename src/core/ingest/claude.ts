import type { SessionRecord, TurnRecord, UsageEventRecord } from "../../shared/types.js";
import { asBool, asNumber, asRecord, asString, extractText, truncateText } from "../text.js";

export interface ParsedBatch {
  sessions: SessionRecord[];
  turns: TurnRecord[];
  usage: UsageEventRecord[];
}

export function emptyBatch(): ParsedBatch {
  return { sessions: [], turns: [], usage: [] };
}

// Every transcript line carries its session, so a batch holds thousands of copies of a few rows.
// Folds them the way upsertSession's conflict clause would, leaving one write per session.
export function foldSessions(sessions: SessionRecord[]): SessionRecord[] {
  const byId = new Map<string, SessionRecord>();
  for (const next of sessions) {
    const current = byId.get(next.id);
    if (!current) {
      byId.set(next.id, next);
      continue;
    }
    byId.set(next.id, {
      ...next,
      cwd: next.cwd ?? current.cwd,
      gitBranch: next.gitBranch ?? current.gitBranch,
      title: next.title ?? current.title,
      parentId: next.parentId ?? current.parentId,
      agentType: next.agentType ?? current.agentType,
      lastTool: next.lastTool !== undefined ? next.lastTool : current.lastTool,
      startedAt: current.startedAt ?? next.startedAt,
      endedAt: next.endedAt ?? current.endedAt,
      lastTs: laterOf(current.lastTs, next.lastTs),
    });
  }
  return [...byId.values()];
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return b > a ? b : a;
}

export function mergeBatch(into: ParsedBatch, extra: ParsedBatch): void {
  into.sessions.push(...extra.sessions);
  into.turns.push(...extra.turns);
  into.usage.push(...extra.usage);
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
  // Subagents write to their own transcript but carry the parent's sessionId, so they need their own key.
  const agentId = asString(rec.agentId);
  const parentId = agentId ? `claude:${sessionId}` : null;
  const nativeId = agentId ? `${sessionId}:${agentId}` : sessionId;
  const id = `claude:${nativeId}`;
  const ts = asString(rec.timestamp) ?? new Date(0).toISOString();
  const cwd = asString(rec.cwd);
  const gitBranch = asString(rec.gitBranch);
  const isSidechain = agentId != null || asBool(rec.isSidechain);
  const batch = emptyBatch();

  // Transcripts supply content only; hook events are the sole source of session state.
  batch.sessions.push({
    id,
    harness: "claude",
    nativeId,
    cwd,
    gitBranch,
    worktree: false,
    title: type === "ai-title" ? asString(rec.aiTitle) : null,
    startedAt: ts,
    endedAt: null,
    lastTs: ts,
    state: "unknown",
    hasBlocking: false,
    isSidechain,
    parentId,
    // Only the subagent's own lines name its type, and only some of them do.
    agentType: agentId ? asString(rec.attributionAgent) : null,
    lastTool: claudeLastTool(type, rec),
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

// Subagents live at <parentSessionId>/subagents/agent-<agentId>.jsonl, so the parent is the grandparent dir.
function sessionIdFromPath(filePath: string): string | null {
  const parts = filePath.split("/");
  const base = parts.at(-1) ?? "";
  if (!base.endsWith(".jsonl")) {
    return null;
  }
  if (parts.at(-2) === "subagents") {
    return parts.at(-3) ?? null;
  }
  return base.slice(0, -".jsonl".length);
}

// An assistant line that calls a tool starts it; the user line carrying its result ends it.
function claudeLastTool(type: string, rec: Record<string, unknown>): string | null | undefined {
  const content = asRecord(rec.message)?.content;
  if (type === "assistant" && Array.isArray(content)) {
    const calls = content.filter((block) => asString(asRecord(block)?.type) === "tool_use");
    const name = asString(asRecord(calls.at(-1))?.name);
    if (name) {
      return name;
    }
    return undefined;
  }
  if (type === "user") {
    return null;
  }
  return undefined;
}
