import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApplyResult } from "../../shared/types.js";
import type { Store } from "../db/store.js";
import { sha256 } from "../hash.js";
import { backupDir } from "../paths.js";

const ALLOWED_BASENAMES = new Set(["CLAUDE.md", "AGENTS.md"]);

export function applySuggestion(store: Store, id: string): ApplyResult {
  const suggestion = store.getSuggestion(id);
  if (!suggestion) {
    return { ok: false, suggestionId: id, targetFile: "", error: "suggestion not found" };
  }
  if (suggestion.status === "applied") {
    return { ok: false, suggestionId: id, targetFile: suggestion.targetFile, error: "already applied" };
  }
  try {
    const target = validateTarget(suggestion.targetFile);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const currentHash = sha256(current);
    if (suggestion.baseHash && suggestion.baseHash !== currentHash) {
      return {
        ok: false,
        suggestionId: id,
        targetFile: target,
        error: "target file changed since the suggestion was planned",
      };
    }
    const next = applyDiff(current, suggestion.diff);
    fs.mkdirSync(backupDir(), { recursive: true });
    const backupPath = path.join(backupDir(), `${id}.bak`);
    fs.writeFileSync(backupPath, current);
    atomicWrite(target, next);
    store.updateSuggestion(id, {
      status: "applied",
      appliedAt: new Date().toISOString(),
      backupPath,
      appliedHash: sha256(next),
    });
    return { ok: true, suggestionId: id, targetFile: target, backupPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateSuggestion(id, { status: "failed" });
    return { ok: false, suggestionId: id, targetFile: suggestion.targetFile, error: message };
  }
}

export function undoSuggestion(store: Store, id: string): ApplyResult {
  const suggestion = store.getSuggestion(id);
  if (!suggestion) {
    return { ok: false, suggestionId: id, targetFile: "", error: "suggestion not found" };
  }
  if (suggestion.status !== "applied" || !suggestion.backupPath) {
    return { ok: false, suggestionId: id, targetFile: suggestion.targetFile, error: "suggestion is not applied" };
  }
  try {
    const target = validateTarget(suggestion.targetFile);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (suggestion.appliedHash && sha256(current) !== suggestion.appliedHash) {
      return {
        ok: false,
        suggestionId: id,
        targetFile: target,
        error: "target changed after apply; refusing to overwrite",
      };
    }
    const backup = fs.readFileSync(suggestion.backupPath, "utf8");
    atomicWrite(target, backup);
    store.updateSuggestion(id, {
      status: "proposed",
      appliedAt: null,
      appliedHash: null,
    });
    return { ok: true, suggestionId: id, targetFile: target, backupPath: suggestion.backupPath };
  } catch (error) {
    return {
      ok: false,
      suggestionId: id,
      targetFile: suggestion.targetFile,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function dismissSuggestion(store: Store, id: string): void {
  store.updateSuggestion(id, { status: "dismissed" });
}

export function validateTarget(targetFile: string): string {
  const resolved = path.resolve(targetFile);
  if (!ALLOWED_BASENAMES.has(path.basename(resolved))) {
    throw new Error("target must be CLAUDE.md or AGENTS.md");
  }
  const parent = path.dirname(resolved);
  const realParent = fs.existsSync(parent) ? fs.realpathSync.native(parent) : parent;
  const candidate = path.join(realParent, path.basename(resolved));
  const home = fs.realpathSync.native(os.homedir());
  if (!candidate.startsWith(home + path.sep) && candidate !== home) {
    throw new Error("target is outside the home directory");
  }
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error("refusing to write through a symlink");
  }
  return candidate;
}

export function applyDiff(before: string, diff: string): string {
  const plus = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  if (plus.length === 0) {
    throw new Error("diff contains no additions");
  }
  if (before.length === 0) {
    return plus.join("\n").endsWith("\n") ? plus.join("\n") : `${plus.join("\n")}\n`;
  }
  const prefix = before.endsWith("\n") ? before : `${before}\n`;
  const added = plus.join("\n");
  return added.endsWith("\n") ? prefix + added : `${prefix}${added}\n`;
}

function atomicWrite(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.sidecar-${path.basename(filePath)}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}
