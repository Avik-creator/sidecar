import type { SessionRecord } from "../shared/types.js";

export function needsYou(session: SessionRecord): boolean {
  return session.state === "needs_attention" || session.hasBlocking;
}

export function attentionIds(sessions: SessionRecord[]): Set<string> {
  return new Set(sessions.filter(needsYou).map((session) => session.id));
}

// A null previous set means this is the first pass, which seeds without notifying.
export function newlyNeedingYou(
  previous: Set<string> | null,
  sessions: SessionRecord[],
  max: number,
): SessionRecord[] {
  if (!previous) {
    return [];
  }
  return sessions.filter((session) => needsYou(session) && !previous.has(session.id)).slice(0, max);
}
