import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClusterRecord } from "../../shared/types.js";
import type { Store } from "../db/store.js";
import { sha256 } from "../hash.js";
import { boundedContext } from "../redaction.js";

interface PlannedSuggestion {
  targetFile: string;
  diff: string;
  rationale: string;
  baseHash: string;
}

export function planCluster(store: Store, cluster: ClusterRecord): PlannedSuggestion | null {
  const members = store.clusterMembers(cluster.id);
  if (members.length === 0) {
    return null;
  }
  const targetFile = chooseTarget(members.map((m) => m.cwd));
  const existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : "";
  const rule = ruleBlock(cluster, members.map((m) => boundedContext(m.text, 280)));
  if (existing.includes(cluster.canonicalKey) || existing.includes(rule.trim())) {
    return null;
  }
  const next = existing.endsWith("\n") || existing.length === 0 ? `${existing}${rule}` : `${existing}\n${rule}`;
  return {
    targetFile,
    diff: unifiedDiff(targetFile, existing, next),
    rationale: `${cluster.distinctSessions} distinct sessions repeated this correction.`,
    baseHash: sha256(existing),
  };
}

function chooseTarget(cwds: Array<string | null>): string {
  const counts = new Map<string, number>();
  for (const cwd of cwds) {
    if (!cwd) {
      continue;
    }
    const repoRule = findRepoRule(cwd);
    if (repoRule) {
      counts.set(repoRule, (counts.get(repoRule) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[0] && ranked[0][1] >= 2) {
    return ranked[0][0];
  }
  return path.join(os.homedir(), ".claude", "CLAUDE.md");
}

function findRepoRule(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i += 1) {
    const claude = path.join(dir, "CLAUDE.md");
    const agents = path.join(dir, "AGENTS.md");
    if (fs.existsSync(claude)) {
      return claude;
    }
    if (fs.existsSync(agents)) {
      return agents;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function ruleBlock(cluster: ClusterRecord, evidence: string[]): string {
  const samples = evidence.slice(0, 3).map((line) => `- ${line.replace(/\n/g, " ")}`).join("\n");
  return `
## Sidecar rule (${cluster.canonicalKey})

Repeated user correction. Follow this going forward:

${cluster.label}

Evidence:
${samples}
`;
}

function unifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  if (before.length === 0) {
    return `${header}@@ -0,0 +1,${afterLines.length} @@\n${afterLines.map((line) => `+${line}`).join("\n")}\n`;
  }
  const start = commonPrefixLength(beforeLines, afterLines);
  const added = afterLines.slice(start);
  return `${header}@@ -${start + 1},0 +${start + 1},${added.length} @@\n${added.map((line) => `+${line}`).join("\n")}\n`;
}

function commonPrefixLength(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) {
    i += 1;
  }
  return i;
}
