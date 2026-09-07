import type { SessionRecord } from "../../shared/types.js";
import type { Store } from "../db/store.js";
import { isProcessAlive, type AliveCheck } from "../native/process.js";

// A working agent emits a hook on every tool call, so silence this long means it died.
const WORKING_TTL_MS = 5 * 60 * 1000;
// Native readers only re-run on ingest, so a running turn gets longer before it is written off.
const NATIVE_WORKING_TTL_MS = 30 * 60 * 1000;
// A permission prompt left this long has almost certainly been answered or timed out.
const BLOCKED_TTL_MS = 30 * 60 * 1000;
// A finished turn stays your problem for a while, but not forever.
const WAITING_TTL_MS = 4 * 60 * 60 * 1000;

export function liveSessions(store: Store, alive: AliveCheck = isProcessAlive): SessionRecord[] {
  const now = Date.now();
  return store
    .listSessions()
    .map((session) => normalizeSession(session, now, alive))
    .sort(compareSessions);
}

export function normalizeSession(
  session: SessionRecord,
  now = Date.now(),
  alive: AliveCheck = isProcessAlive,
): SessionRecord {
  // Nothing has ever reported this session, so make no claim about what it is doing.
  if (!session.hookTs) {
    return { ...session, state: "unknown", hasBlocking: false };
  }
  if (session.state === "ended" || session.state === "unknown") {
    return { ...session, hasBlocking: false };
  }
  const running = session.pid != null ? alive(session.pid) : null;
  if (running === false) {
    return { ...session, state: "ended", hasBlocking: false };
  }
  const reported = Date.parse(session.hookTs);
  const age = Number.isFinite(reported) ? now - reported : Number.POSITIVE_INFINITY;
  if (age > ttlFor(session, running === true)) {
    return { ...session, state: "ended", hasBlocking: false };
  }
  return session;
}

function ttlFor(session: SessionRecord, running: boolean): number {
  if (session.state === "active") {
    // A live process that says it is busy is busy, however long the turn takes.
    if (running) {
      return Number.POSITIVE_INFINITY;
    }
    return session.stateSource && session.stateSource !== "hook" ? NATIVE_WORKING_TTL_MS : WORKING_TTL_MS;
  }
  return session.hasBlocking ? BLOCKED_TTL_MS : WAITING_TTL_MS;
}

export function compareSessions(a: SessionRecord, b: SessionRecord): number {
  const delta = rank(a) - rank(b);
  if (delta !== 0) {
    return delta;
  }
  return (b.lastTs ?? "").localeCompare(a.lastTs ?? "");
}

function rank(session: SessionRecord): number {
  if (session.state === "needs_attention" && session.hasBlocking) {
    return 0;
  }
  if (session.state === "needs_attention") {
    return 1;
  }
  if (session.state === "active") {
    return 2;
  }
  return session.state === "unknown" ? 4 : 3;
}
