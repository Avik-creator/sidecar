import fs from "node:fs";
import path from "node:path";
import { asRecord } from "./text.js";
import { settingsPath } from "./paths.js";
import type { Settings } from "../shared/types.js";

// Improve reads your transcripts and edits rule files, so it stays off until you turn it on.
export const DEFAULT_SETTINGS: Settings = {
  improveEnabled: false,
  improveGlobalRules: false,
};

export function readSettings(file = settingsPath()): Settings {
  try {
    const parsed = asRecord(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
    return {
      improveEnabled: bool(parsed?.improveEnabled, DEFAULT_SETTINGS.improveEnabled),
      improveGlobalRules: bool(parsed?.improveGlobalRules, DEFAULT_SETTINGS.improveGlobalRules),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(patch: Partial<Settings>, file = settingsPath()): Settings {
  const next = { ...readSettings(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
