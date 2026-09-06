import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, describe, expect, it } from "vitest";
import { isRelevantChange, watchRoots, type WatchPaths } from "../src/main/watch-targets.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): WatchPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-watch-"));
  tmpDirs.push(dir);
  const paths: WatchPaths = {
    claudeDir: path.join(dir, "claude", "projects"),
    codexDir: path.join(dir, "codex", "sessions"),
    cursorDb: path.join(dir, "cursor", "state.vscdb"),
    spoolDir: path.join(dir, "sidecar", "hooks"),
  };
  fs.mkdirSync(path.join(paths.claudeDir, "-Users-me-proj"), { recursive: true });
  fs.mkdirSync(path.join(paths.codexDir, "2026", "09", "06"), { recursive: true });
  fs.mkdirSync(path.dirname(paths.cursorDb), { recursive: true });
  fs.mkdirSync(paths.spoolDir, { recursive: true });
  return paths;
}

async function collectEvents(paths: WatchPaths, act: () => void): Promise<string[]> {
  const seen: string[] = [];
  const watcher = chokidar.watch(watchRoots(paths), {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });
  try {
    await new Promise<void>((resolve) => watcher.on("ready", () => resolve()));
    // Listener must be attached before acting, or a fast event is missed.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(repeat);
        clearTimeout(timer);
        resolve();
      };
      watcher.on("all", (_event, changed) => {
        if (isRelevantChange(changed, paths)) {
          seen.push(changed);
          done();
        }
      });
      // Recursive fs.watch needs a moment to arm, so keep appending like a live agent would.
      act();
      const repeat = setInterval(act, 250);
      const timer = setTimeout(done, 10_000);
    });
  } finally {
    await watcher.close();
  }
  return seen;
}

describe("source watching", () => {
  it("fires for a Claude transcript nested under the projects directory", async () => {
    const paths = fixture();
    const target = path.join(paths.claudeDir, "-Users-me-proj", "session.jsonl");
    const seen = await collectEvents(paths, () => {
      fs.writeFileSync(target, `${JSON.stringify({ type: "user" })}\n`);
    });
    expect(seen).toContain(target);
  });

  it("fires for a Codex transcript nested under dated session directories", async () => {
    const paths = fixture();
    const target = path.join(paths.codexDir, "2026", "09", "06", "rollout.jsonl");
    const seen = await collectEvents(paths, () => {
      fs.writeFileSync(target, `${JSON.stringify({ type: "session_meta" })}\n`);
    });
    expect(seen).toContain(target);
  });

  it("fires for a spooled hook event", async () => {
    const paths = fixture();
    const target = path.join(paths.spoolDir, "20260906062008355100000-1-claude-Stop.json");
    const seen = await collectEvents(paths, () => {
      fs.writeFileSync(target, JSON.stringify({ ts: "2026-09-06T06:20:08Z", harness: "claude", type: "Stop" }));
    });
    expect(seen).toContain(target);
  });

  it("ignores non-transcript files inside the watched directories", () => {
    const paths = fixture();
    expect(isRelevantChange(path.join(paths.claudeDir, "notes.md"), paths)).toBe(false);
    expect(isRelevantChange(path.join(paths.claudeDir, "p", "s.jsonl"), paths)).toBe(true);
    expect(isRelevantChange(paths.cursorDb, paths)).toBe(true);
    expect(isRelevantChange(`${paths.cursorDb}-wal`, paths)).toBe(true);
    expect(isRelevantChange("/somewhere/else/s.jsonl", paths)).toBe(false);
    expect(isRelevantChange(path.join(paths.spoolDir, "1-claude-Stop.json"), paths)).toBe(true);
    expect(isRelevantChange(path.join(paths.spoolDir, "1-claude-Stop.tmp"), paths)).toBe(false);
  });
});
