import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { hooksLogPath, sidecarHome } from "../paths.js";

interface HookEvent {
  harness: "claude" | "codex" | "cursor";
  type: string;
  sessionId?: string;
  payload?: unknown;
}

export function appendHook(event: HookEvent): void {
  fs.mkdirSync(sidecarHome(), { recursive: true });
  const line = JSON.stringify({
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...event,
  });
  fs.appendFileSync(hooksLogPath(), `${line}\n`);
}
