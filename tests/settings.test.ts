import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../src/core/settings.js";
import { validateTarget } from "../src/core/improve/apply.js";
import { globalRulesPath } from "../src/core/improve/plan.js";
import { runImprove } from "../src/core/improve/pipeline.js";
import { Store } from "../src/core/db/store.js";
import type { TurnRecord } from "../src/shared/types.js";

const tmpDirs: string[] = [];
const originalHome = process.env.SIDECAR_HOME;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.SIDECAR_HOME;
  } else {
    process.env.SIDECAR_HOME = originalHome;
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-settings-"));
  tmpDirs.push(dir);
  return dir;
}

describe("settings", () => {
  it("defaults Improve off, since it reads transcripts and edits rule files", () => {
    expect(DEFAULT_SETTINGS.improveEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.improveGlobalRules).toBe(false);
    expect(readSettings(path.join(tmp(), "missing.json"))).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a patch without dropping the other keys", () => {
    const file = path.join(tmp(), "settings.json");
    expect(writeSettings({ improveEnabled: true }, file)).toEqual({ ...DEFAULT_SETTINGS, improveEnabled: true });
    expect(writeSettings({ improveGlobalRules: true }, file).improveEnabled).toBe(true);
    expect(readSettings(file)).toEqual({ ...DEFAULT_SETTINGS, improveEnabled: true, improveGlobalRules: true });
  });

  it("keeps preferences within what the app can honour", () => {
    const file = path.join(tmp(), "settings.json");
    expect(writeSettings({ hotkey: null, quietFrom: "22:00", quietTo: "07:30", quotaAlertPct: 250 }, file)).toMatchObject({
      hotkey: null,
      quietFrom: "22:00",
      quietTo: "07:30",
      quotaAlertPct: 100,
    });
    // A malformed time or a blank hotkey falls back rather than breaking notifications.
    expect(writeSettings({ quietFrom: "25:99", hotkey: "  " }, file)).toMatchObject({ quietFrom: null, hotkey: "Alt+Shift+S" });
  });

  it("falls back to defaults on a corrupt settings file", () => {
    const file = path.join(tmp(), "settings.json");
    fs.writeFileSync(file, "{not json");
    expect(readSettings(file)).toEqual(DEFAULT_SETTINGS);
  });
});

function seedCorrection(store: Store): void {
  store.upsertSession({
    id: "claude:s1",
    harness: "claude",
    nativeId: "s1",
    cwd: "/tmp/repo",
    gitBranch: null,
    worktree: false,
    title: null,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: null,
    lastTs: "2026-01-01T00:00:00Z",
    state: "unknown",
    hasBlocking: false,
    isSidechain: false,
    parentId: null,
    agentType: null,
  });
  const turn: TurnRecord = {
    id: "t1",
    sessionId: "claude:s1",
    sourceEventId: "e1",
    role: "user",
    ts: "2026-01-01T00:00:00Z",
    model: null,
    text: "No, don't write tests in that folder. I told you to use tests/unit.",
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
  };
  store.insertTurn(turn);
}

describe("improve gate", () => {
  it("does not even read transcripts while Improve is off", () => {
    const store = Store.open(path.join(tmp(), "db.sqlite"));
    seedCorrection(store);
    // The same store with the gate open finds this correction, so zero here is the gate.
    expect(runImprove(store, { ...DEFAULT_SETTINGS, improveEnabled: true }).candidates).toBe(1);
    store.replaceCandidates([]);
    const report = runImprove(store, { ...DEFAULT_SETTINGS });
    expect(report).toEqual({
      candidates: 0,
      clusters: 0,
      promoted: 0,
      suggestions: 0,
      usedRemoteLlm: false,
    });
    expect(store.listCandidates(10)).toHaveLength(0);
    store.close();
  });

  it("refuses to write the global rules file unless it is turned on", () => {
    process.env.SIDECAR_HOME = tmp();
    expect(() => validateTarget(globalRulesPath())).toThrow(/turned off/);
    writeSettings({ improveGlobalRules: true });
    expect(validateTarget(globalRulesPath())).toBe(path.resolve(globalRulesPath()));
  });
});
