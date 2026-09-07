import type { SessionRecord } from "./types.js";

// Claude Code and Codex tool names, folded into the handful of verbs a glance needs.
const VERBS: Array<[RegExp, string]> = [
  [/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/i, "Editing"],
  [/^(Read|read_file|view_image)$/i, "Reading"],
  [/^(Bash|exec|shell|local_shell|exec_command|run_command|container\.exec)$/i, "Running command"],
  [/^(Grep|Glob|LS|search|grep_search|codebase_search|list_dir)$/i, "Searching"],
  [/^(Task|Agent|spawn_agent|Workflow)$/i, "Delegating"],
  [/^(WebFetch|WebSearch|web_search|browser_.*)$/i, "Browsing"],
  [/^AskUserQuestion$/i, "Asking you"],
];

export function toolVerb(tool: string): string {
  for (const [pattern, verb] of VERBS) {
    if (pattern.test(tool)) {
      return verb;
    }
  }
  const mcp = /^mcp__([^_]+)__/.exec(tool);
  if (mcp?.[1]) {
    return `Using ${mcp[1]}`;
  }
  return `Using ${tool}`;
}

// One line under the title: what the agent is doing right now and for how long.
export function activityLabel(session: SessionRecord, now = Date.now()): string {
  if (session.state === "needs_attention") {
    return session.hasBlocking ? "Needs permission" : "Your turn";
  }
  if (session.state === "active") {
    const verb = session.lastTool ? toolVerb(session.lastTool) : "Thinking";
    const elapsed = turnDuration(session, now);
    return elapsed ? `${verb} · ${elapsed}` : verb;
  }
  if (session.state === "ended") {
    return "Done";
  }
  return "Not reporting";
}

export function turnDuration(session: SessionRecord, now = Date.now()): string | null {
  if (!session.lastPromptTs) {
    return null;
  }
  const started = Date.parse(session.lastPromptTs);
  if (!Number.isFinite(started) || started > now) {
    return null;
  }
  return formatDuration(now - started);
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// "claude-sonnet-4-5-20250929" reads as "sonnet 4.5"; unknown shapes are shown as they are.
export function shortModel(model: string | null | undefined): string | null {
  if (!model) {
    return null;
  }
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(model);
  if (claude?.[1] && claude[2]) {
    return `${claude[1]} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }
  return model.replace(/-\d{8}$/, "").replace(/-preview$/, "");
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  }
  return String(tokens);
}
