import { randomUUID } from "node:crypto";
import { PROMOTE_MIN_SESSIONS } from "../constants.js";
import type { Store } from "../db/store.js";
import { shortHash } from "../hash.js";
import { prefilterTurns, type PrefilterHit } from "./prefilter.js";
import type { ClusterRecord, ImproveReport } from "../../shared/types.js";
import { planCluster } from "./plan.js";

export function runImprove(store: Store): ImproveReport {
  const turns = store.listTurnsForPrefilter();
  const hits = prefilterTurns(turns);
  const createdAt = new Date().toISOString();
  store.replaceCandidates(
    hits.map((hit) => ({
      turnId: hit.turn.id,
      signals: hit.signals,
      score: hit.score,
      createdAt,
    })),
  );
  store.db.prepare(`DELETE FROM suggestion WHERE status = 'proposed'`).run();

  const grouped = new Map<string, PrefilterHit[]>();
  for (const hit of hits) {
    const key = hit.canonicalKey || "misc";
    const list = grouped.get(key) ?? [];
    list.push(hit);
    grouped.set(key, list);
  }

  let promoted = 0;
  let suggestions = 0;
  for (const [canonicalKey, members] of grouped) {
    const sessions = new Set(members.map((m) => m.turn.sessionId));
    const days = new Set(members.map((m) => m.turn.ts.slice(0, 10)));
    const distinctTasks = Math.max(sessions.size, days.size);
    const status = sessions.size >= PROMOTE_MIN_SESSIONS ? "promoted" : "open";
    const cluster: ClusterRecord = {
      id: shortHash(`cluster:${canonicalKey}`),
      label: members[0]?.label ?? canonicalKey,
      canonicalKey,
      count: members.length,
      distinctSessions: sessions.size,
      distinctTasks,
      status,
      version: 1,
    };
    store.upsertCluster(cluster);
    store.replaceMemberships(
      cluster.id,
      cluster.version,
      members.map((m) => ({ turnId: m.turn.id, sessionId: m.turn.sessionId })),
    );
    if (status === "promoted") {
      promoted += 1;
      const suggestion = planCluster(store, cluster);
      if (suggestion) {
        store.insertSuggestion({
          id: randomUUID(),
          clusterId: cluster.id,
          targetFile: suggestion.targetFile,
          diff: suggestion.diff,
          rationale: suggestion.rationale,
          status: "proposed",
          baseHash: suggestion.baseHash,
          createdAt,
          appliedAt: null,
          backupPath: null,
          appliedHash: null,
        });
        suggestions += 1;
      }
    }
  }

  return {
    candidates: hits.length,
    clusters: grouped.size,
    promoted,
    suggestions,
    usedRemoteLlm: false,
  };
}
