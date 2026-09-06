import { asRecord, asString } from "../text.js";
import type { Harness, SessionState } from "../../shared/types.js";

export interface HookOutcome {
  state: SessionState;
  hasBlocking: boolean;
}

const WORKING: HookOutcome = { state: "active", hasBlocking: false };
const BLOCKED: HookOutcome = { state: "needs_attention", hasBlocking: true };
const YOUR_TURN: HookOutcome = { state: "needs_attention", hasBlocking: false };
const FINISHED: HookOutcome = { state: "ended", hasBlocking: false };

// Claude Code and Codex use PascalCase event names; Cursor uses camelCase.
const CLAUDE_EVENTS: Record<string, HookOutcome> = {
  SessionStart: WORKING,
  UserPromptSubmit: WORKING,
  PreToolUse: WORKING,
  PostToolUse: WORKING,
  PostToolUseFailure: WORKING,
  PermissionRequest: BLOCKED,
  Notification: BLOCKED,
  Stop: YOUR_TURN,
  StopFailure: YOUR_TURN,
  SubagentStart: WORKING,
  SubagentStop: FINISHED,
  SessionEnd: FINISHED,
};

const CODEX_EVENTS: Record<string, HookOutcome> = {
  SessionStart: WORKING,
  UserPromptSubmit: WORKING,
  PreToolUse: WORKING,
  PostToolUse: WORKING,
  PermissionRequest: BLOCKED,
  Stop: YOUR_TURN,
  Interrupt: YOUR_TURN,
  SubagentStart: WORKING,
  SubagentStop: FINISHED,
  SessionEnd: FINISHED,
};

const CURSOR_EVENTS: Record<string, HookOutcome> = {
  sessionStart: WORKING,
  beforeSubmitPrompt: WORKING,
  preToolUse: WORKING,
  postToolUse: WORKING,
  beforeShellExecution: BLOCKED,
  beforeMCPExecution: BLOCKED,
  stop: YOUR_TURN,
  sessionEnd: FINISHED,
};

const BY_HARNESS: Record<Harness, Record<string, HookOutcome>> = {
  claude: CLAUDE_EVENTS,
  codex: CODEX_EVENTS,
  cursor: CURSOR_EVENTS,
};

export function hookOutcome(harness: Harness, type: string): HookOutcome | null {
  return BY_HARNESS[harness][type] ?? null;
}

// A subagent never waits on the user, so its finished turn is an end rather than your turn.
export function outcomeForSubagent(outcome: HookOutcome): HookOutcome {
  return outcome === YOUR_TURN ? FINISHED : outcome;
}

// Claude and Codex add these to every payload emitted inside a subagent, not just the Subagent events.
export function agentIdFromPayload(payload: unknown): string | null {
  return asString(asRecord(payload)?.agent_id);
}

export function agentTypeFromPayload(payload: unknown): string | null {
  return asString(asRecord(payload)?.agent_type);
}

export function installedEvents(harness: Harness): string[] {
  return Object.keys(BY_HARNESS[harness]);
}

export function sessionIdFromPayload(harness: Harness, payload: unknown): string | null {
  const rec = asRecord(payload);
  if (!rec) {
    return null;
  }
  if (harness === "cursor") {
    return asString(rec.conversation_id) ?? asString(rec.composerId) ?? asString(rec.session_id);
  }
  return asString(rec.session_id) ?? asString(rec.sessionId);
}

export function cwdFromPayload(harness: Harness, payload: unknown): string | null {
  const rec = asRecord(payload);
  if (!rec) {
    return null;
  }
  if (harness === "cursor") {
    const roots = rec.workspace_roots;
    if (Array.isArray(roots)) {
      const first = roots.find((root) => typeof root === "string" && root.length > 0);
      if (typeof first === "string") {
        return first;
      }
    }
    return asString(rec.cwd);
  }
  return asString(rec.cwd);
}
