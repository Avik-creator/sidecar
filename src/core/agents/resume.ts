import type { SessionRecord } from "../../shared/types.js";

// The command that reopens this session in a terminal; null when the harness has no resume.
export function resumeCommand(session: SessionRecord): string | null {
  const id = session.nativeId.split(":")[0] ?? session.nativeId;
  let command: string;
  switch (session.harness) {
    case "claude":
      command = `claude --resume ${shellQuote(id)}`;
      break;
    case "codex":
      command = `codex resume ${shellQuote(id)}`;
      break;
    default:
      return null;
  }
  return session.cwd ? `cd ${shellQuote(session.cwd)} && ${command}` : command;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
