import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function channels(file: string, pattern: RegExp): string[] {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  return [...source.matchAll(pattern)].map((match) => match[1] as string);
}

describe("renderer bridge", () => {
  // TypeScript checks the API shape; nothing checks that the channel strings still line up.
  it("invokes only channels the main process handles", () => {
    const handled = new Set(channels("src/main/index.ts", /ipcMain\.handle\("([^"]+)"/g));
    const invoked = channels("src/preload/index.ts", /ipcRenderer\.invoke\("([^"]+)"/g);
    expect(invoked.length).toBeGreaterThan(0);
    expect(invoked.filter((channel) => !handled.has(channel))).toEqual([]);
  });

  it("exposes the hook installer to the renderer", () => {
    const invoked = channels("src/preload/index.ts", /ipcRenderer\.invoke\("([^"]+)"/g);
    expect(invoked).toContain("sidecar:hooksStatus");
    expect(invoked).toContain("sidecar:installHooks");
    expect(invoked).toContain("sidecar:uninstallHooks");
  });
});
