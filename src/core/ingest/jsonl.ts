import fs from "node:fs";
import type { SourceFileState } from "../db/store.js";
import { MAX_JSONL_LINE, PARSER_VERSION } from "../constants.js";
import type { Harness } from "../../shared/types.js";

interface JsonlLine {
  text: string;
}

interface FileIdentity {
  inode: string;
  size: number;
  mtimeMs: number;
}

export function fileIdentity(filePath: string): FileIdentity | null {
  try {
    const stat = fs.statSync(filePath);
    return {
      inode: `${stat.dev}:${stat.ino}`,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

export function resumeOffset(previous: SourceFileState | undefined, identity: FileIdentity): number {
  if (!previous) {
    return 0;
  }
  if (previous.parserVersion !== PARSER_VERSION) {
    return 0;
  }
  if (previous.inode && previous.inode !== identity.inode) {
    return 0;
  }
  if (identity.size < previous.byteOffset) {
    return 0;
  }
  return previous.byteOffset;
}

export function readJsonlFromOffset(filePath: string, startOffset: number): {
  lines: JsonlLine[];
  nextOffset: number;
  failures: number;
} {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (startOffset > stat.size) {
      return { lines: [], nextOffset: 0, failures: 0 };
    }
    const length = stat.size - startOffset;
    if (length <= 0) {
      return { lines: [], nextOffset: startOffset, failures: 0 };
    }
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, startOffset);
    const chunk = buffer.toString("utf8");
    const parts = chunk.split("\n");
    const complete = parts.slice(0, -1);
    const remainder = chunk.endsWith("\n") ? "" : (parts.at(-1) ?? "");
    const lines: JsonlLine[] = [];
    let cursor = startOffset;
    let failures = 0;
    for (const part of complete) {
      const recordBytes = Buffer.byteLength(part, "utf8") + 1;
      if (part.length > MAX_JSONL_LINE) {
        failures += 1;
        cursor += recordBytes;
        continue;
      }
      if (part.trim().length > 0) {
        lines.push({ text: part });
      }
      cursor += recordBytes;
    }
    return { lines, nextOffset: cursor, failures: remainder.length > MAX_JSONL_LINE ? failures + 1 : failures };
  } finally {
    fs.closeSync(fd);
  }
}

export function nextSourceState(
  filePath: string,
  harness: Harness,
  identity: FileIdentity,
  nextOffset: number,
  watermark: string | null = null,
): SourceFileState {
  return {
    path: filePath,
    harness,
    inode: identity.inode,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    byteOffset: nextOffset,
    parserVersion: PARSER_VERSION,
    watermark,
  };
}
