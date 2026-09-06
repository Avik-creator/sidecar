import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hooksSpoolDir } from "../paths.js";

interface HookEvent {
  harness: "claude" | "codex" | "cursor";
  type: string;
  sessionId?: string;
  payload?: unknown;
}

export function appendHook(event: HookEvent): void {
  const dir = hooksSpoolDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = asPayloadRecord(event.payload);
  if (event.sessionId && payload.session_id == null && payload.conversation_id == null) {
    payload.session_id = event.sessionId;
  }
  const body = JSON.stringify({
    ts: new Date().toISOString(),
    harness: event.harness,
    type: event.type,
    payload,
  });
  const base = path.join(dir, `${Date.now()}-${randomUUID()}`);
  fs.writeFileSync(`${base}.tmp`, body);
  fs.renameSync(`${base}.tmp`, `${base}.json`);
}

function asPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>) };
  }
  return {};
}
