import type { TurnRecord } from "../../shared/types.js";
import { isSyntheticUserText } from "../ingest/claude.js";
import { firstLine, significantTokens, stripCodeFences } from "../text.js";

export interface PrefilterHit {
  turn: TurnRecord;
  signals: string[];
  score: number;
  canonicalKey: string;
  label: string;
}

const LEXICAL: Array<{ id: string; re: RegExp }> = [
  { id: "no_dont", re: /\bno,?\s+don['’]?t\b/i },
  { id: "actually", re: /\bactually\b/i },
  { id: "i_told_you", re: /\bi told you\b/i },
  { id: "thats_wrong", re: /\bthat['’]?s wrong\b/i },
  { id: "you_keep", re: /\byou keep\b/i },
  { id: "i_said", re: /\bi said\b/i },
  { id: "stop_doing", re: /\bstop (?:doing|using|writing|adding|changing|creating)\b/i },
  { id: "do_not", re: /\bdo not\b/i },
  { id: "wrong_file", re: /\bwrong (?:file|approach|way|place|dir(?:ectory)?)\b/i },
  { id: "again", re: /\b(?:once )?again\b/i },
];

const UNEXPECTED_STOP = new Set(["user_cancel", "cancelled", "canceled", "abort", "aborted", "error"]);

export function prefilterTurns(turns: TurnRecord[]): PrefilterHit[] {
  const bySession = new Map<string, TurnRecord[]>();
  for (const turn of turns) {
    const list = bySession.get(turn.sessionId) ?? [];
    list.push(turn);
    bySession.set(turn.sessionId, list);
  }
  const hits: PrefilterHit[] = [];
  for (const sessionTurns of bySession.values()) {
    sessionTurns.sort((a, b) => a.ts.localeCompare(b.ts));
    let lastPermission: string | null = null;
    let assistantPending = false;
    for (const turn of sessionTurns) {
      if (turn.role === "assistant") {
        assistantPending = true;
        const structural: string[] = [];
        if (turn.preventedContinuation) {
          structural.push("prevented_continuation");
        }
        if (turn.stopReason && UNEXPECTED_STOP.has(turn.stopReason.toLowerCase())) {
          structural.push("unexpected_stop");
        }
        if (structural.length > 0) {
          hits.push(hit(turn, structural, 2 * structural.length));
        }
        continue;
      }
      if (turn.role !== "user" || !turn.isUserPrompt) {
        continue;
      }
      if (isSyntheticUserText(turn.text)) {
        continue;
      }
      const signals: string[] = [];
      let score = 0;
      if (turn.interrupted) {
        signals.push("interrupt");
        score += 2;
      } else if (assistantPending && looksLikeInterrupt(turn.text)) {
        signals.push("interrupt");
        score += 1.5;
      }
      if (turn.permissionMode && lastPermission && turn.permissionMode !== lastPermission) {
        signals.push("permission_flip");
        score += 2;
      }
      if (turn.permissionMode) {
        lastPermission = turn.permissionMode;
      }
      const lexical = lexicalHits(turn.text);
      for (const id of lexical) {
        signals.push(id);
        score += 1;
      }
      assistantPending = false;
      if (signals.length > 0) {
        hits.push(hit(turn, signals, score));
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function hit(turn: TurnRecord, signals: string[], score: number): PrefilterHit {
  const tokens = significantTokens(turn.text);
  const primary = signals[0] ?? "correction";
  const canonicalKey = `${primary}:${tokens.slice(0, 6).join(" ")}`.trim();
  return {
    turn,
    signals,
    score,
    canonicalKey,
    label: firstLine(stripCodeFences(turn.text)).slice(0, 160) || canonicalKey,
  };
}

function lexicalHits(text: string): string[] {
  if (text.length > 4_000) {
    return [];
  }
  const haystack = stripCodeFences(text).split(/\r?\n/).slice(0, 6).join("\n").slice(0, 500);
  const ids: string[] = [];
  for (const rule of LEXICAL) {
    if (rule.re.test(haystack)) {
      ids.push(rule.id);
    }
  }
  return ids;
}

function looksLikeInterrupt(text: string): boolean {
  return /^(stop|wait|no|cancel|don't|dont)\b/i.test(text.trim());
}
