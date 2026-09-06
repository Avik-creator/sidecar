import fs from "node:fs";
import path from "node:path";
import { asRecord, asString } from "../text.js";
import type { Harness } from "../../shared/types.js";

export interface SpoolEvent {
  file: string;
  ts: string;
  harness: Harness;
  type: string;
  payload: unknown;
}

export interface SpoolBatch {
  events: SpoolEvent[];
  failures: number;
  files: string[];
}

const HARNESSES = new Set<string>(["claude", "codex", "cursor"]);

export function readSpool(dir: string, limit = 5_000): SpoolBatch {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return { events: [], failures: 0, files: [] };
  }
  entries.sort();
  const events: SpoolEvent[] = [];
  const files: string[] = [];
  let failures = 0;
  for (const name of entries.slice(0, limit)) {
    const file = path.join(dir, name);
    files.push(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch {
      failures += 1;
      continue;
    }
    const rec = asRecord(parsed);
    const harness = asString(rec?.harness);
    const type = asString(rec?.type);
    if (!rec || !harness || !type || !HARNESSES.has(harness)) {
      failures += 1;
      continue;
    }
    events.push({
      file,
      ts: asString(rec.ts) ?? new Date().toISOString(),
      harness: harness as Harness,
      type,
      payload: rec.payload ?? null,
    });
  }
  return { events, failures, files };
}

export function clearSpool(files: string[]): void {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // A file we cannot remove is replayed next pass; inserts are idempotent.
    }
  }
}
