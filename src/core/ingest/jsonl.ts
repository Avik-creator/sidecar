import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { SourceFileState } from "../db/store.js";
import { MAX_JSONL_LINE, PARSER_VERSION } from "../constants.js";
import type { Harness } from "../../shared/types.js";

const READ_CHUNK_BYTES = 1024 * 1024;

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

// Streams a chunk at a time; a cold ingest reads transcripts far larger than we want resident.
export function readJsonlFromOffset(
  filePath: string,
  startOffset: number,
  onLine: (text: string) => void,
): { nextOffset: number; failures: number } {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (startOffset > stat.size) {
      return { nextOffset: 0, failures: 0 };
    }
    let remaining = stat.size - startOffset;
    if (remaining <= 0) {
      return { nextOffset: startOffset, failures: 0 };
    }
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const decoder = new StringDecoder("utf8");
    let position = startOffset;
    let cursor = startOffset;
    let failures = 0;
    let pending = "";

    while (remaining > 0) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), position);
      if (read <= 0) {
        break;
      }
      position += read;
      remaining -= read;
      pending += decoder.write(buffer.subarray(0, read));
      let from = 0;
      let newline = pending.indexOf("\n", from);
      while (newline >= 0) {
        const part = pending.slice(from, newline);
        cursor += Buffer.byteLength(part, "utf8") + 1;
        if (part.length > MAX_JSONL_LINE) {
          failures += 1;
        } else if (part.trim().length > 0) {
          onLine(part);
        }
        from = newline + 1;
        newline = pending.indexOf("\n", from);
      }
      pending = from > 0 ? pending.slice(from) : pending;
    }
    // A trailing partial line stays unread until its newline arrives.
    return { nextOffset: cursor, failures: pending.length > MAX_JSONL_LINE ? failures + 1 : failures };
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
