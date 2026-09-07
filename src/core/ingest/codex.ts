import type { ParsedBatch } from "./claude.js";
import { emptyBatch } from "./claude.js";
import { shortHash } from "../hash.js";
import { asNumber, asRecord, asString, extractText, truncateText } from "../text.js";
import type { TurnRecord } from "../../shared/types.js";

export function parseCodexLine(filePath: string, line: string, sessionHint?: string): ParsedBatch | "skip" | "fail" {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return "fail";
  }
  const type = asString(rec.type);
  const ts = asString(rec.timestamp) ?? new Date(0).toISOString();
  const payload = asRecord(rec.payload) ?? {};
  const batch = emptyBatch();

  if (type === "session_meta") {
    const nativeId = asString(payload.id) ?? asString(payload.session_id) ?? idFromFilename(filePath);
    const sessionId = `codex:${nativeId}`;
    const git = asRecord(payload.git);
    batch.sessions.push({
      id: sessionId,
      harness: "codex",
      nativeId,
      cwd: asString(payload.cwd),
      gitBranch: asString(git?.branch),
      worktree: false,
      title: null,
      startedAt: asString(payload.timestamp) ?? ts,
      endedAt: null,
      lastTs: ts,
      state: "unknown",
      hasBlocking: false,
      isSidechain: asString(payload.thread_source) === "subagent",
      parentId: null,
      agentType: null,
    });
    return batch;
  }

  const nativeId = sessionHint ?? idFromFilename(filePath);
  const sessionId = `codex:${nativeId}`;
  const eventType = type === "event_msg" ? asString(payload.type) : null;
  batch.sessions.push({
    id: sessionId,
    harness: "codex",
    nativeId,
    cwd: asString(payload.cwd),
    gitBranch: null,
    worktree: false,
    title: null,
    startedAt: ts,
    endedAt: null,
    lastTs: ts,
    state: "unknown",
    hasBlocking: false,
    isSidechain: false,
    parentId: null,
    agentType: null,
    lastTool: codexLastTool(type, payload, eventType),
  });

  if (type === "turn_context") {
    batch.sessions[0] = {
      ...batch.sessions[0]!,
      cwd: asString(payload.cwd) ?? batch.sessions[0]!.cwd,
    };
    return batch;
  }

  if (type === "response_item") {
    const roleRaw = asString(payload.role) ?? asString(payload.type);
    const role = mapCodexRole(roleRaw);
    if (!role) {
      return "skip";
    }
    const sourceEventId =
      asString(payload.id) ??
      `${roleRaw}:${ts}:${shortHash(line).slice(0, 12)}`;
    const turn: TurnRecord = {
      id: `codex:${sourceEventId}`,
      sessionId,
      sourceEventId,
      role,
      ts,
      model: asString(payload.model),
      text: truncateText(extractText(payload.content ?? payload.text)),
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      stopReason: null,
      permissionMode: null,
      preventedContinuation: false,
      isSidechain: false,
      interrupted: false,
      cursorRulesJson: null,
      parentId: null,
      isUserPrompt: role === "user",
    };
    batch.turns.push(turn);
    return batch;
  }

  if (type === "event_msg") {
    const resolvedEventType = eventType ?? "event_msg";
    const sourceEventId = `${resolvedEventType}:${ts}:${shortHash(line).slice(0, 12)}`;
    if (resolvedEventType === "token_count") {
      const info = asRecord(payload.info);
      const last = asRecord(info?.last_token_usage);
      if (last) {
        batch.usage.push({
          sessionId,
          turnId: null,
          sourceEventId,
          harness: "codex",
          ts,
          model: null,
          tokensIn: asNumber(last.input_tokens),
          tokensOut: asNumber(last.output_tokens) + asNumber(last.reasoning_output_tokens),
          cacheRead: asNumber(last.cached_input_tokens),
          cacheWrite: asNumber(last.cache_write_input_tokens),
        });
      }
    }
    if (resolvedEventType === "user_message") {
      const text = truncateText(extractText(payload.message ?? payload.text ?? payload.content));
      if (text) {
        batch.turns.push({
          id: `codex:${sourceEventId}`,
          sessionId,
          sourceEventId,
          role: "user",
          ts,
          model: null,
          text,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheWrite: 0,
          stopReason: null,
          permissionMode: null,
          preventedContinuation: false,
          isSidechain: false,
          interrupted: false,
          cursorRulesJson: null,
          parentId: null,
          isUserPrompt: true,
        });
      }
    }
    return batch;
  }

  return "skip";
}

export function idFromFilename(filePath: string): string {
  const base = filePath.split("/").at(-1) ?? "unknown";
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? base.replace(/\.jsonl$/, "");
}

function mapCodexRole(role: string | null): TurnRecord["role"] | null {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "developer":
    case "system":
      return "system";
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
      return "tool";
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "reasoning":
      return "assistant";
    default:
      return null;
  }
}

// Tool call items start a tool; their output items and a new user message end it.
function codexLastTool(
  type: string | null,
  payload: Record<string, unknown>,
  eventType: string | null,
): string | null | undefined {
  if (type === "response_item") {
    const itemType = asString(payload.type) ?? "";
    if (itemType.endsWith("_call_output")) {
      return null;
    }
    if (itemType === "local_shell_call") {
      return "shell";
    }
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      return asString(payload.name) ?? "tool";
    }
    return undefined;
  }
  return type === "event_msg" && eventType === "user_message" ? null : undefined;
}
