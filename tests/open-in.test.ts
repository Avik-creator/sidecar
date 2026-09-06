import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editorCandidates, existingDir, findExecutable } from "../src/main/open-in.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-open-"));
  tmpDirs.push(dir);
  return dir;
}

describe("opening a session in place", () => {
  it("prefers Cursor for a Cursor session and an explicit editor over both", () => {
    expect(editorCandidates("cursor", {})[0]).toBe("cursor");
    expect(editorCandidates("claude", {})[0]).toBe("code");
    expect(editorCandidates("claude", { SIDECAR_EDITOR: "zed" })[0]).toBe("zed");
  });

  it("finds an executable on the path and ignores one that is not executable", () => {
    const dir = tmp();
    const good = path.join(dir, "code");
    fs.writeFileSync(good, "#!/bin/sh\n");
    fs.chmodSync(good, 0o755);
    fs.writeFileSync(path.join(dir, "subl"), "not executable");
    expect(findExecutable("code", [dir])).toBe(good);
    expect(findExecutable("subl", [dir])).toBeNull();
    expect(findExecutable("nothing-here", [dir])).toBeNull();
  });

  it("refuses a cwd that is gone, so the button reports instead of dying silently", () => {
    const dir = tmp();
    expect(existingDir(dir)).toBe(dir);
    expect(existingDir(path.join(dir, "missing"))).toBeNull();
    expect(existingDir(null)).toBeNull();
  });
});
