import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/core/db/store.js";
import { applySuggestion, undoSuggestion, validateTarget } from "../src/core/improve/apply.js";
import { ingestAll } from "../src/core/ingest/engine.js";
import { runImprove } from "../src/core/improve/pipeline.js";
import { buildUsageReport } from "../src/core/usage/report.js";
import { SidecarService } from "../src/core/app.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

describe("store uniqueness", () => {
  it("does not duplicate turns or usage on replay", () => {
    const dir = tmp();
    const db = Store.open(path.join(dir, "db.sqlite"));
    const turn = {
      id: "claude:u1",
      sessionId: "claude:s1",
      sourceEventId: "u1",
      role: "assistant" as const,
      ts: "2026-01-01T00:00:00Z",
      model: "claude-haiku-4.5",
      text: "hi",
      tokensIn: 1,
      tokensOut: 2,
      cacheRead: 0,
      cacheWrite: 0,
      stopReason: null,
      permissionMode: null,
      preventedContinuation: false,
      isSidechain: false,
      interrupted: false,
      cursorRulesJson: null,
      parentId: null,
      isUserPrompt: false,
    };
    db.upsertSession({
      id: "claude:s1",
      harness: "claude",
      nativeId: "s1",
      cwd: "/tmp",
      gitBranch: "main",
      worktree: false,
      title: "t",
      startedAt: turn.ts,
      endedAt: null,
      lastTs: turn.ts,
      state: "active",
      hasBlocking: false,
      isSidechain: false,
    });
    expect(db.insertTurn(turn)).toBe(true);
    expect(db.insertTurn(turn)).toBe(false);
    expect(
      db.insertUsage({
        sessionId: "claude:s1",
        turnId: turn.id,
        sourceEventId: "u1",
        harness: "claude",
        ts: turn.ts,
        model: turn.model,
        tokensIn: 1,
        tokensOut: 2,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(true);
    expect(
      db.insertUsage({
        sessionId: "claude:s1",
        turnId: turn.id,
        sourceEventId: "u1",
        harness: "claude",
        ts: turn.ts,
        model: turn.model,
        tokensIn: 1,
        tokensOut: 2,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(false);
    db.close();
  });

  it("only reports a Claude permission request while it is actually pending", () => {
    const dir = tmp();
    const db = Store.open(path.join(dir, "db.sqlite"));
    db.upsertSession({
      id: "claude:s1",
      harness: "claude",
      nativeId: "s1",
      cwd: "/tmp",
      gitBranch: null,
      worktree: false,
      title: "task",
      startedAt: "2026-08-01T00:00:00Z",
      endedAt: null,
      lastTs: "2026-08-01T00:00:00Z",
      state: "needs_attention",
      hasBlocking: true,
      isSidechain: false,
    });

    expect(db.listSessions()[0]).toMatchObject({ state: "unknown", hasBlocking: false });

    db.insertEvent({
      sessionId: "claude:s1",
      harness: "claude",
      type: "PermissionRequest",
      ts: "2026-08-01T00:01:00Z",
      payloadJson: "{}",
      sourceEventId: "permission-1",
    });
    expect(db.listSessions()[0]).toMatchObject({ state: "needs_attention", hasBlocking: true });

    db.insertTurn({
      id: "claude:a1",
      sessionId: "claude:s1",
      sourceEventId: "a1",
      role: "assistant",
      ts: "2026-08-01T00:02:00Z",
      model: null,
      text: "continuing",
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
      isUserPrompt: false,
    });
    expect(db.listSessions()[0]).toMatchObject({ state: "unknown", hasBlocking: false });
    db.close();
  });
});

describe("ingest + improve e2e", () => {
  it("ingests fixtures, matches usage, and promotes a repeated correction", () => {
    const dir = tmp();
    const claudeDir = path.join(dir, "claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    for (let i = 1; i <= 3; i += 1) {
      const session = `s${i}`;
      const lines = [
        {
          type: "user",
          sessionId: session,
          uuid: `${session}-u1`,
          timestamp: `2026-08-0${i}T10:00:00.000Z`,
          cwd: path.join(dir, "repo"),
          message: { role: "user", content: "add a button" },
        },
        {
          type: "assistant",
          sessionId: session,
          uuid: `${session}-a1`,
          timestamp: `2026-08-0${i}T10:00:01.000Z`,
          cwd: path.join(dir, "repo"),
          message: {
            model: "claude-haiku-4.5",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        },
        {
          type: "user",
          sessionId: session,
          uuid: `${session}-u2`,
          timestamp: `2026-08-0${i}T10:00:02.000Z`,
          cwd: path.join(dir, "repo"),
          message: { role: "user", content: "No, don't put styles inline. I told you to use the CSS file." },
        },
      ];
      fs.writeFileSync(path.join(claudeDir, `${session}.jsonl`), `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`);
    }

    const store = Store.open(path.join(dir, "db.sqlite"));
    const report = ingestAll(store, { claudeDir, codexDir: path.join(dir, "missing-codex"), cursorDb: path.join(dir, "missing.vscdb") });
    expect(report.turnsUpserted).toBe(9);
    expect(report.usageEvents).toBe(3);
    const usage = buildUsageReport(store, 400, "UTC");
    const haikuRows = usage.days.filter((row) => row.model === "claude-haiku-4.5");
    const tokensIn = haikuRows.reduce((sum, row) => sum + row.tokensIn, 0);
    const tokensOut = haikuRows.reduce((sum, row) => sum + row.tokensOut, 0);
    expect(tokensIn).toBe(300);
    expect(tokensOut).toBe(60);
    expect(usage.totals.usdEstimate).toBeCloseTo(300 / 1_000_000 * 1 + 60 / 1_000_000 * 5, 8);

    const improve = runImprove(store);
    expect(improve.candidates).toBeGreaterThanOrEqual(3);
    expect(improve.promoted).toBeGreaterThanOrEqual(1);
    expect(improve.suggestions).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

describe("apply + undo", () => {
  it("writes with backup and refuses to undo after a later edit", () => {
    const dir = tmp();
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const target = path.join(home, ".claude", "CLAUDE.md");
      fs.writeFileSync(target, "# rules\n");
      expect(validateTarget(target)).toBe(fs.realpathSync.native(target));

      const store = Store.open(path.join(dir, "db.sqlite"));
      store.upsertCluster({
        id: "c1",
        label: "label",
        canonicalKey: "k",
        count: 3,
        distinctSessions: 3,
        distinctTasks: 3,
        status: "promoted",
        version: 1,
      });
      store.insertSuggestion({
        id: "sug-1",
        clusterId: "c1",
        targetFile: target,
        diff: `--- a/${target}\n+++ b/${target}\n@@ -1,0 +2,1 @@\n+do not inline styles\n`,
        rationale: "test",
        status: "proposed",
        baseHash: null,
        createdAt: new Date().toISOString(),
        appliedAt: null,
        backupPath: null,
        appliedHash: null,
      });
      const previous = process.env.SIDECAR_HOME;
      process.env.SIDECAR_HOME = path.join(dir, "sidecar-home");
      try {
        const applied = applySuggestion(store, "sug-1");
        expect(applied.ok).toBe(true);
        expect(fs.readFileSync(target, "utf8")).toContain("do not inline styles");
        fs.appendFileSync(target, "changed by user\n");
        const undone = undoSuggestion(store, "sug-1");
        expect(undone.ok).toBe(false);
        expect(undone.error).toMatch(/changed after apply/);
      } finally {
        if (previous === undefined) {
          delete process.env.SIDECAR_HOME;
        } else {
          process.env.SIDECAR_HOME = previous;
        }
      }
      store.close();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});

describe("service", () => {
  it("opens a database and reports health", async () => {
    const dir = tmp();
    const svc = SidecarService.open(path.join(dir, "sidecar.sqlite"));
    const health = await svc.health();
    expect(health.sessions).toBe(0);
    svc.close();
  });
});
