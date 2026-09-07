import { execFileSync } from "node:child_process";
import path from "node:path";
import type { OpenResult } from "../shared/types.js";

export type Runner = (command: string, args: string[]) => string;

export const run: Runner = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });

interface Ancestor {
  pid: number;
  ppid: number;
  command: string;
}

// Walks parent processes until launchd, so the terminal or editor hosting the agent can be found.
export function ancestry(pid: number, exec: Runner = run): Ancestor[] {
  const chain: Ancestor[] = [];
  let current = pid;
  for (let depth = 0; depth < 12 && current > 1; depth += 1) {
    const line = exec("ps", ["-o", "ppid=,command=", "-p", String(current)]).trim();
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      break;
    }
    chain.push({ pid: current, ppid: Number(match[1]), command: match[2] ?? "" });
    current = Number(match[1]);
  }
  return chain;
}

// The outermost .app on the first ancestor that lives inside a bundle.
export function hostApp(chain: Ancestor[]): string | null {
  for (const ancestor of chain) {
    const match = /^(.*?\.app)\/Contents\//.exec(ancestor.command);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function ttyOf(pid: number, exec: Runner = run): string | null {
  const tty = exec("ps", ["-o", "tty=", "-p", String(pid)]).trim();
  return tty && tty !== "??" ? `/dev/${tty}` : null;
}

// Terminal and iTerm2 can select the exact tab by tty; anything else just comes to the front.
export function terminalScript(appName: string, tty: string): string | null {
  const escaped = tty.replace(/"/g, '\\"');
  if (appName === "Terminal") {
    return `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${escaped}" then
        set selected tab of w to t
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "missing"`;
  }
  if (appName === "iTerm" || appName === "iTerm2") {
    return `tell application "${appName}"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${escaped}" then
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "missing"`;
  }
  return null;
}

// Brings the window that owns this process to the front, choosing the tab when the app allows it.
export function focusProcess(pid: number, exec: Runner = run): OpenResult {
  let app: string | null;
  try {
    app = hostApp(ancestry(pid, exec));
  } catch (error) {
    return { ok: false, opened: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (!app) {
    return { ok: false, opened: null, error: "This agent is not running inside a window Sidecar can find." };
  }
  const appName = path.basename(app, ".app");
  try {
    const tty = ttyOf(pid, exec);
    const script = tty ? terminalScript(appName, tty) : null;
    if (script && exec("osascript", ["-e", script]).trim() === "ok") {
      return { ok: true, opened: appName, error: null };
    }
    exec("open", [app]);
    return { ok: true, opened: appName, error: null };
  } catch (error) {
    return { ok: false, opened: appName, error: error instanceof Error ? error.message : String(error) };
  }
}
