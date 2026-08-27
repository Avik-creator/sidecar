import type { SessionRecord } from "../../shared/types.js";
import type { Store } from "../db/store.js";

const STALE_MS = 30 * 60 * 1000;
const RECENT_UNKNOWN_MS = 5 * 60 * 1000;

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
  if (session.state === "unknown" && age <= RECENT_UNKNOWN_MS) {
    return { ...session, state: "active" };
  }
  return session;
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
