import { describe, expect, it } from "vitest";
import { resumeCommand } from "../src/core/agents/resume.js";
import { processesByCwd } from "../src/core/native/process.js";
import { ancestry, focusProcess, hostApp, terminalScript, ttyOf, type Runner } from "../src/main/focus.js";
import type { SessionRecord } from "../src/shared/types.js";

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, "id" | "harness" | "nativeId">): SessionRecord {
  return {
    cwd: "/Users/me/proj",
    gitBranch: null,
    worktree: false,
    title: null,
    startedAt: null,
    endedAt: null,
    lastTs: null,
    state: "active",
    hasBlocking: false,
    isSidechain: false,
    parentId: null,
    agentType: null,
    ...partial,
  };
}

// A fake process table: claude under zsh under VS Code's helper, plus one Terminal.app shell.
const TABLE: Record<string, string> = {
  "63452": "63032 claude",
  "63032": "63029 /bin/zsh",
  "63029": "62877 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=ptyHost",
  "62877": "1 /Applications/Visual Studio Code.app/Contents/MacOS/Code",
  "700": "699 codex",
  "699": "698 -zsh",
  "698": "1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
  "900": "1 node server.js",
};

function fakeRunner(calls: string[][], overrides: Record<string, string> = {}): Runner {
  return (command, args) => {
    calls.push([command, ...args]);
    const key = `${command} ${args.join(" ")}`;
    if (key in overrides) {
      return overrides[key] ?? "";
    }
    if (command === "ps" && args[0] === "-o" && args[1] === "ppid=,command=") {
      return `${TABLE[args[3] ?? ""] ?? ""}\n`;
    }
    if (command === "ps" && args[1] === "tty=") {
      return args[3] === "700" ? "ttys004\n" : args[3] === "900" ? "??\n" : "ttys001\n";
    }
    return "";
  };
}

describe("finding the window that owns an agent", () => {
  it("walks the parent chain to the outermost app bundle", () => {
    const chain = ancestry(63452, fakeRunner([]));
    expect(chain.map((row) => row.pid)).toEqual([63452, 63032, 63029, 62877]);
    expect(hostApp(chain)).toBe("/Applications/Visual Studio Code.app");
    expect(hostApp(ancestry(700, fakeRunner([])))).toBe("/System/Applications/Utilities/Terminal.app");
    expect(hostApp(ancestry(900, fakeRunner([])))).toBeNull();
  });

  it("reads the tty and leaves it null for a process without one", () => {
    expect(ttyOf(700, fakeRunner([]))).toBe("/dev/ttys004");
    expect(ttyOf(900, fakeRunner([]))).toBeNull();
  });

  it("selects the exact Terminal tab by tty and only activates other apps", () => {
    const script = terminalScript("Terminal", "/dev/ttys004");
    expect(script).toContain('tty of t is "/dev/ttys004"');
    expect(script).toContain("set selected tab of w to t");
    expect(terminalScript("iTerm2", "/dev/ttys004")).toContain("sessions of t");
    expect(terminalScript("Code", "/dev/ttys001")).toBeNull();

    const calls: string[][] = [];
    const codex = focusProcess(700, fakeRunner(calls, { [`osascript -e ${script}`]: "ok\n" }));
    expect(codex).toEqual({ ok: true, opened: "Terminal", error: null });
    expect(calls.some((call) => call[0] === "open")).toBe(false);

    const editorCalls: string[][] = [];
    const claude = focusProcess(63452, fakeRunner(editorCalls));
    expect(claude).toEqual({ ok: true, opened: "Visual Studio Code", error: null });
    expect(editorCalls.at(-1)).toEqual(["open", "/Applications/Visual Studio Code.app"]);
  });

  it("reports a process it cannot place instead of guessing", () => {
    expect(focusProcess(900, fakeRunner([])).ok).toBe(false);
    const dead: Runner = () => {
      throw new Error("No such process");
    };
    expect(focusProcess(4242, dead)).toMatchObject({ ok: false, error: "No such process" });
  });
});

describe("matching a Codex process to its thread", () => {
  it("maps each codex process to its working directory", () => {
    const exec: Runner = (command, args) => {
      if (command === "ps") {
        return "  700 codex\n  701 /opt/homebrew/bin/codex\n  702 node\n";
      }
      if (command === "lsof") {
        return args[2] === "700" ? "p700\nfcwd\nn/Users/me/one\n" : "p701\nfcwd\nn/Users/me/two\n";
      }
      return "";
    };
    const byCwd = processesByCwd("codex", exec);
    expect([...byCwd.entries()]).toEqual([
      ["/Users/me/one", 700],
      ["/Users/me/two", 701],
    ]);
    expect(processesByCwd("codex", () => "").size).toBe(0);
  });
});

describe("resume commands", () => {
  it("reopens Claude and Codex sessions in their folder and has nothing for Cursor", () => {
    expect(resumeCommand(session({ id: "claude:abc", harness: "claude", nativeId: "abc-123" }))).toBe(
      "cd /Users/me/proj && claude --resume abc-123",
    );
    // A subagent resumes its parent session.
    expect(resumeCommand(session({ id: "claude:abc:sub", harness: "claude", nativeId: "abc-123:a1", cwd: null }))).toBe(
      "claude --resume abc-123",
    );
    expect(resumeCommand(session({ id: "codex:t", harness: "codex", nativeId: "t1", cwd: "/tmp/it's here" }))).toBe(
      "cd '/tmp/it'\\''s here' && codex resume t1",
    );
    expect(resumeCommand(session({ id: "cursor:c", harness: "cursor", nativeId: "c1" }))).toBeNull();
  });
});
