import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileIdentity, readJsonlFromOffset, resumeOffset } from "../src/core/ingest/jsonl.js";
import { PARSER_VERSION } from "../src/core/constants.js";
import type { SourceFileState } from "../src/core/db/store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-jsonl-"));
  tmpDirs.push(dir);
  return dir;
}

describe("jsonl tailer", () => {
  it("keeps a partial last line until a newline arrives", () => {
    const dir = tmp();
    const filePath = path.join(dir, "a.jsonl");
    fs.writeFileSync(filePath, '{"id":1}\n{"id":2');
    const first = readJsonlFromOffset(filePath, 0);
    expect(first.lines.map((l) => l.text)).toEqual(['{"id":1}']);
    expect(first.nextOffset).toBe(Buffer.byteLength('{"id":1}\n', "utf8"));

    fs.appendFileSync(filePath, '}\n{"id":3}\n');
    const second = readJsonlFromOffset(filePath, first.nextOffset);
    expect(second.lines.map((l) => l.text)).toEqual(['{"id":2}', '{"id":3}']);
  });

  it("restarts from zero after truncation or inode change", () => {
    const dir = tmp();
    const filePath = path.join(dir, "b.jsonl");
    fs.writeFileSync(filePath, '{"a":1}\n{"a":2}\n');
    const identity = fileIdentity(filePath)!;
    const previous: SourceFileState = {
      path: filePath,
      harness: "claude",
      inode: identity.inode,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
      byteOffset: identity.size,
      parserVersion: PARSER_VERSION,
      watermark: null,
    };
    expect(resumeOffset(previous, identity)).toBe(identity.size);

    fs.writeFileSync(filePath, '{"a":9}\n');
    const truncated = fileIdentity(filePath)!;
    expect(resumeOffset(previous, truncated)).toBe(0);

    const rotated: SourceFileState = { ...previous, inode: "other:1", byteOffset: 99 };
    expect(resumeOffset(rotated, identity)).toBe(0);
  });
});
