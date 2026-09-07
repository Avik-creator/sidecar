import fs from "node:fs";
import path from "node:path";
import { asRecord } from "./text.js";
import { settingsPath } from "./paths.js";
import type { Settings } from "../shared/types.js";

// Improve reads your transcripts and edits rule files, so it stays off until you turn it on.
// Hooks are the opposite: without them Sidecar cannot see any session, so they install themselves.
export const DEFAULT_SETTINGS: Settings = {
  improveEnabled: false,
  improveGlobalRules: false,
  hooksAutoInstall: true,
  launchAtLogin: false,
  hotkey: "Alt+Shift+S",
  quietFrom: null,
  quietTo: null,
  quotaAlertPct: 90,
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function readSettings(file = settingsPath()): Settings {
  try {
    const parsed = asRecord(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
    return {
      improveEnabled: bool(parsed?.improveEnabled, DEFAULT_SETTINGS.improveEnabled),
      improveGlobalRules: bool(parsed?.improveGlobalRules, DEFAULT_SETTINGS.improveGlobalRules),
      hooksAutoInstall: bool(parsed?.hooksAutoInstall, DEFAULT_SETTINGS.hooksAutoInstall),
      launchAtLogin: bool(parsed?.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
      hotkey: text(parsed?.hotkey, DEFAULT_SETTINGS.hotkey),
      quietFrom: time(parsed?.quietFrom),
      quietTo: time(parsed?.quietTo),
      quotaAlertPct: percent(parsed?.quotaAlertPct, DEFAULT_SETTINGS.quotaAlertPct),
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
  return readSettings(file);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// null is a deliberate "none"; anything that is not a string falls back.
function text(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function time(value: unknown): string | null {
  return typeof value === "string" && TIME.test(value) ? value : null;
}

function percent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback;
}
