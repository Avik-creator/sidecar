import type { Harness, SessionState, StateSource } from "../../shared/types.js";

// One session's state as read from its harness's own files, before it is written to the store.
export interface NativeState {
  harness: Harness;
  nativeId: string;
  cwd: string | null;
  title: string | null;
  state: SessionState;
  hasBlocking: boolean;
  ts: string;
  // What was read, such as "registry:busy" or "turn:inProgress", kept for the panel and debugging.
  eventType: string;
  source: Exclude<StateSource, "hook">;
  pid: number | null;
  parentId: string | null;
  agentType: string | null;
}

export const WORKING = { state: "active", hasBlocking: false } as const;
export const BLOCKED = { state: "needs_attention", hasBlocking: true } as const;
export const YOUR_TURN = { state: "needs_attention", hasBlocking: false } as const;
export const ENDED = { state: "ended", hasBlocking: false } as const;

export function isoFromMs(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value).toISOString();
}
