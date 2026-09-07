import fs from "node:fs";
import path from "node:path";
import { asNumber, asRecord, asString } from "../text.js";
import type { AliveCheck } from "./process.js";
import { BLOCKED, ENDED, WORKING, YOUR_TURN, isoFromMs, type NativeState } from "./state.js";

// Claude Code's own vocabulary: busy and shell mean a turn is running, waiting means a prompt is up.
const STATUS = {
  busy: WORKING,
  shell: WORKING,
  waiting: BLOCKED,
  idle: YOUR_TURN,
} as const;

// Background and daemon processes are not sessions a person is sitting at.
const SKIPPED_KINDS = new Set(["daemon", "daemon-worker"]);

// Reads ~/.claude/sessions/<pid>.json, one file per running Claude Code process.
export function readClaudeRegistry(dir: string, alive: AliveCheck): NativeState[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: NativeState[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const entry = readEntry(path.join(dir, name), alive);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

function readEntry(filePath: string, alive: AliveCheck): NativeState | null {
  let rec: Record<string, unknown> | null;
  try {
    rec = asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
  const sessionId = asString(rec?.sessionId);
  const pid = asNumber(rec?.pid);
  if (!rec || !sessionId || pid <= 0) {
    return null;
  }
  if (SKIPPED_KINDS.has(asString(rec.kind) ?? "")) {
    return null;
  }
  const status = asString(rec.status) ?? "";
  const known = (STATUS as Record<string, { state: NativeState["state"]; hasBlocking: boolean }>)[status];
  const ts =
    isoFromMs(Math.max(asNumber(rec.updatedAt), asNumber(rec.statusUpdatedAt), asNumber(rec.startedAt))) ??
    new Date().toISOString();
  // A file whose process is gone is a crash leftover; Claude Code removes it on a clean exit.
  const outcome = !alive(pid) ? ENDED : known;
  if (!outcome) {
    return null;
  }
  return {
    harness: "claude",
    nativeId: sessionId,
    cwd: asString(rec.cwd),
    title: asString(rec.name),
    state: outcome.state,
    hasBlocking: outcome.hasBlocking,
    ts,
    eventType: `registry:${outcome === ENDED ? "gone" : status}`,
    source: "claude-registry",
    pid,
    parentId: null,
    agentType: null,
  };
}
