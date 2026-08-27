import type {
  HealthReport,
  SessionRecord,
  SetupItemRecord,
  SidecarApi,
  SidecarShell,
  SuggestionRecord,
  UsageReport,
} from "@shared/types";

export function installPreviewBridge(): void {
  window.sidecar = previewApi();
  window.sidecarShell = previewShell();
  window.sidecarEvents = {
    onChanged: () => () => undefined,
  };
}

function previewShell(): SidecarShell {
  return {
    setPinned: async () => undefined,
    hidePanel: async () => undefined,
    quitApp: async () => undefined,
  };
}

function previewApi(): SidecarApi {
  const health = previewHealth();
  const sessions = previewSessions();
  const setup = previewSetup();
  const usage = previewUsage();
  return {
    health: async () => health,
    ingest: async () => ({
      filesSeen: 12,
      recordsRead: 40,
      turnsUpserted: 18,
      usageEvents: 9,
      parseFailures: 0,
      durationMs: 24,
    }),
    usage: async () => usage,
    sessions: async () => sessions,
    setup: async () => setup,
    candidates: async () => [],
    clusters: async () => [],
    suggestions: async () => previewSuggestions(),
    runImprove: async () => ({
      candidates: 0,
      clusters: 0,
      promoted: 0,
      suggestions: 0,
      usedRemoteLlm: false,
    }),
    applySuggestion: async (id) => ({ ok: true, suggestionId: id, targetFile: "" }),
    undoSuggestion: async (id) => ({ ok: true, suggestionId: id, targetFile: "" }),
    dismissSuggestion: async () => undefined,
  };
}

function previewHealth(): HealthReport {
  return {
    dbPath: "~/.sidecar/sidecar.sqlite",
    sessions: 3,
    turns: 18,
    candidates: 4,
    suggestions: 1,
    integrations: [
      { harness: "claude", status: "ok", lastOkAt: new Date().toISOString(), lagMs: 120, parseFailures: 0, lastError: null },
      { harness: "codex", status: "ok", lastOkAt: new Date().toISOString(), lagMs: 80, parseFailures: 0, lastError: null },
      { harness: "cursor", status: "ok", lastOkAt: new Date().toISOString(), lagMs: 200, parseFailures: 0, lastError: null },
    ],
  };
}

function previewSessions(): SessionRecord[] {
  const now = Date.now();
  return [
    session({
      id: "claude:preview",
      harness: "claude",
      title: "Allow edit to app.css",
      activity: "Allow edit to app.css",
      state: "needs_attention",
      hasBlocking: true,
      lastRole: "user",
      lastTs: new Date(now - 40_000).toISOString(),
    }),
    session({
      id: "codex:preview",
      harness: "codex",
      title: "Wire live usage windows",
      activity: "Wire live usage windows",
      state: "active",
      lastRole: "user",
      lastTs: new Date(now - 20_000).toISOString(),
    }),
    session({
      id: "cursor:preview",
      harness: "cursor",
      title: "Keep Improve fully local",
      activity: "Keep Improve fully local",
      state: "active",
      lastRole: "assistant",
      lastTs: new Date(now - 8_000).toISOString(),
    }),
  ];
}

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, "id" | "harness" | "state">): SessionRecord {
  return {
    nativeId: partial.id,
    cwd: "/Users/avik/Desktop/project/sidecar",
    gitBranch: "main",
    worktree: false,
    title: "task",
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastTs: new Date().toISOString(),
    hasBlocking: false,
    isSidechain: false,
    activity: "task",
    lastRole: "assistant",
    ...partial,
  };
}

function previewSetup(): SetupItemRecord[] {
  return [
    item("claude", "skill", "Commit locally"),
    item("codex", "rule", "AGENTS.md"),
    item("cursor", "mcp", "GitHub"),
    item("gemini-cli", "skill", "Review diffs"),
  ];
}

function item(
  harness: SetupItemRecord["harness"],
  kind: SetupItemRecord["kind"],
  title: string,
): SetupItemRecord {
  return {
    id: `${harness}:${kind}:${title}`,
    harness,
    kind,
    path: `~/.${harness}/${title}`,
    title,
    scope: "global",
    mtimeMs: Date.now(),
    hash: "preview",
    preview: "Indexed from local files. Sidecar never rewrites the source.",
  };
}

function previewUsage(): UsageReport {
  return {
    timezone: "Asia/Kolkata",
    priceVersion: 1,
    days: [
      { day: "2026-08-27", harness: "claude", model: "sonnet", tokensIn: 7000, tokensOut: 2200, cacheRead: 0, cacheWrite: 0, usdEstimate: 0.28 },
      { day: "2026-08-27", harness: "codex", model: "gpt", tokensIn: 4000, tokensOut: 1400, cacheRead: 0, cacheWrite: 0, usdEstimate: 0.09 },
      { day: "2026-08-27", harness: "cursor", model: "composer", tokensIn: 1000, tokensOut: 400, cacheRead: 0, cacheWrite: 0, usdEstimate: 0.05 },
    ],
    calendarDays: [
      { day: "2026-08-27", tokensIn: 12000, tokensOut: 4000, usdEstimate: 0.42 },
      { day: "2026-08-26", tokensIn: 8000, tokensOut: 2100, usdEstimate: 0.27 },
    ],
    totals: { tokensIn: 20000, tokensOut: 6100, cacheRead: 0, cacheWrite: 0, usdEstimate: 0.69 },
    live: [
      {
        provider: "claude",
        plan: "Max",
        status: "ok",
        fetchedAt: new Date().toISOString(),
        error: null,
        windows: [
          { label: "Session", used: 21, limit: 100, unit: "percent", resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
          { label: "Weekly", used: 0, limit: 100, unit: "percent", resetsAt: new Date(Date.now() + 604_800_000).toISOString() },
        ],
        details: [],
      },
      {
        provider: "codex",
        plan: "Pro 20x",
        status: "ok",
        fetchedAt: new Date().toISOString(),
        error: null,
        windows: [{ label: "Weekly", used: 24, limit: 100, unit: "percent", resetsAt: new Date(Date.now() + 86_400_000).toISOString() }],
        details: [],
      },
      {
        provider: "cursor",
        plan: "Pro",
        status: "ok",
        fetchedAt: new Date().toISOString(),
        error: null,
        windows: [{ label: "Total usage", used: 33, limit: 100, unit: "percent", resetsAt: new Date(Date.now() + 864_000_000).toISOString() }],
        details: [],
      },
    ],
    notes: [],
  };
}

function previewSuggestions(): SuggestionRecord[] {
  return [
    {
      id: "sug-1",
      clusterId: "c1",
      targetFile: "/Users/avik/Desktop/project/sidecar/AGENTS.md",
      diff: "- Always dump logs into chat\n+ Keep local transcripts; Sidecar already indexes them",
      rationale: "The same correction showed up in Claude Code, Codex, and Cursor.",
      status: "proposed",
      baseHash: "a",
      createdAt: new Date().toISOString(),
      appliedAt: null,
      backupPath: null,
      appliedHash: null,
    },
  ];
}
