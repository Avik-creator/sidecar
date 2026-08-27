import type { SessionRecord } from "../../shared/types.js";
import type { Store } from "../db/store.js";

const IDLE_MS = 2 * 60 * 1000;
const WORKING_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
const RECENT_UNKNOWN_MS = 2 * 60 * 1000;

export function liveSessions(store: Store): SessionRecord[] {
  const now = Date.now();
  return store
    .listSessions()
    .map((session) => normalizeSession(session, now))
    .sort(compareSessions);
}

export function normalizeSession(session: SessionRecord, now = Date.now()): SessionRecord {
  const last = session.lastTs ? Date.parse(session.lastTs) : NaN;
  const age = Number.isFinite(last) ? now - last : Number.POSITIVE_INFINITY;
  if (session.hasBlocking && age <= STALE_MS) {
    return { ...session, state: "needs_attention" };
  }
  if (age > STALE_MS) {
    return { ...session, state: "ended", hasBlocking: false };
  }
  if (session.state === "ended") {
    return { ...session, hasBlocking: false };
  }
  const current =
    session.state === "unknown" && age <= RECENT_UNKNOWN_MS
      ? { ...session, state: "active" as const }
      : session;
  if (current.state === "unknown") {
    return { ...current, state: "ended", hasBlocking: false };
  }
  if (current.state === "active" && current.lastRole === "user" && age > WORKING_MS) {
    return { ...current, state: "ended", hasBlocking: false };
  }
  if (current.state === "active" && current.lastRole !== "user" && age > IDLE_MS) {
    return { ...current, state: "ended", hasBlocking: false };
  }
  return current;
}

export function compareSessions(a: SessionRecord, b: SessionRecord): number {
  const rank = (session: SessionRecord): number => {
    if (session.state === "needs_attention" || session.hasBlocking) {
      return 0;
    }
    if (session.state === "active") {
      return 1;
    }
    return 2;
  };
  const delta = rank(a) - rank(b);
  if (delta !== 0) {
    return delta;
  }
  return (b.lastTs ?? "").localeCompare(a.lastTs ?? "");
}
