export type Harness = "claude" | "codex" | "cursor";

export type SetupSource =
  | Harness
  | "antigravity"
  | "cline"
  | "cline-cli"
  | "claude-desktop"
  | "fx"
  | "gemini-cli"
  | "goose"
  | "github-copilot-cli"
  | "grok-build"
  | "kilo-code"
  | "kimi-code"
  | "kiro-cli"
  | "mcporter"
  | "opencode"
  | "universal"
  | "vscode"
  | "windsurf"
  | "zed";

export type SessionState =
  | "active"
  | "ended"
  | "needs_attention"
  | "unknown";

export type TurnRole = "user" | "assistant" | "system" | "tool";

// Where a session's state last came from: a hook event or a harness's own on-disk state.
export type StateSource = "hook" | "claude-registry" | "codex-db" | "cursor-db";

export type SuggestionStatus =
  | "proposed"
  | "applied"
  | "dismissed"
  | "failed";

export type SetupKind = "rule" | "skill" | "mcp" | "hook" | "agent" | "plugin" | "plan";

export type ClusterStatus = "open" | "promoted" | "ignored";

export interface SessionRecord {
  id: string;
  harness: Harness;
  nativeId: string;
  cwd: string | null;
  gitBranch: string | null;
  worktree: boolean;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastTs: string | null;
  state: SessionState;
  hasBlocking: boolean;
  isSidechain: boolean;
  // Set on a subagent row; points at the session that spawned it.
  parentId: string | null;
  // The subagent's name, such as "Explore" or "general-purpose".
  agentType: string | null;
  // Timestamp of the last state report from any source; null means nothing has reported yet.
  hookTs?: string | null;
  hookEvent?: string | null;
  stateSource?: StateSource | null;
  // Process id of the agent when its harness publishes one, so a dead process reads as ended.
  pid?: number | null;
  activity?: string | null;
  lastRole?: TurnRole | null;
  // Tool currently in flight; null once its result came back, undefined when a parser makes no claim.
  lastTool?: string | null;
  // When the current turn began, so the panel can show how long the agent has been at it.
  lastPromptTs?: string | null;
  model?: string | null;
  tokens?: number;
  usd?: number;
  tasksDone?: number | null;
  tasksTotal?: number | null;
  queued?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
}

// Counters a harness keeps for a session; only Cursor and Codex publish any of them today.
export interface SessionFacts {
  tasksDone?: number | null;
  tasksTotal?: number | null;
  queued?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  sourceEventId: string;
  role: TurnRole;
  ts: string;
  model: string | null;
  text: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  stopReason: string | null;
  permissionMode: string | null;
  preventedContinuation: boolean;
  isSidechain: boolean;
  interrupted: boolean;
  cursorRulesJson: string | null;
  parentId: string | null;
  isUserPrompt: boolean;
}

export interface UsageEventRecord {
  sessionId: string;
  turnId: string | null;
  sourceEventId: string;
  harness: Harness;
  ts: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CandidateRecord {
  turnId: string;
  sessionId: string;
  harness: Harness;
  ts: string;
  text: string;
  signals: string[];
  score: number;
  cwd: string | null;
}

export interface ClusterRecord {
  id: string;
  label: string;
  canonicalKey: string;
  count: number;
  distinctSessions: number;
  distinctTasks: number;
  status: ClusterStatus;
  version: number;
}

export interface SuggestionRecord {
  id: string;
  clusterId: string;
  targetFile: string;
  diff: string;
  rationale: string | null;
  status: SuggestionStatus;
  baseHash: string | null;
  createdAt: string;
  appliedAt: string | null;
  backupPath: string | null;
  appliedHash: string | null;
}

export interface SetupItemRecord {
  id: string;
  harness: SetupSource;
  kind: SetupKind;
  path: string;
  title: string | null;
  scope: "global" | "repo";
  mtimeMs: number | null;
  hash: string | null;
  preview: string | null;
}

export interface IntegrationHealth {
  harness: Harness;
  status: "ok" | "degraded" | "unavailable";
  lastOkAt: string | null;
  lagMs: number | null;
  parseFailures: number;
  lastError: string | null;
}

export interface HookStatus {
  harness: Harness;
  configPath: string;
  // False when the agent has no home directory here, so Sidecar leaves its config alone.
  detected: boolean;
  installed: boolean;
  present: string[];
  missing: string[];
  foreignEntries: number;
  note: string | null;
  // Last hook event Sidecar received from this harness; null with installed means it never fired.
  lastEventAt: string | null;
}

export interface IngestReport {
  filesSeen: number;
  recordsRead: number;
  turnsUpserted: number;
  usageEvents: number;
  parseFailures: number;
  durationMs: number;
}

export interface UsageDayRow {
  day: string;
  harness: Harness;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  usdEstimate: number;
}

export type LiveUsageStatus =
  | "ok"
  | "stale"
  | "rate_limited"
  | "unauthenticated"
  | "unavailable";

export type UsageWindowUnit = "percent" | "usd" | "count";

export interface UsageWindow {
  label: string;
  used: number;
  limit: number;
  unit: UsageWindowUnit;
  resetsAt: string | null;
}

export interface UsageCalendarDay {
  day: string;
  tokensIn: number;
  tokensOut: number;
  usdEstimate: number;
}

export interface LiveUsageSnapshot {
  provider: Harness;
  plan: string | null;
  status: LiveUsageStatus;
  fetchedAt: string | null;
  error: string | null;
  windows: UsageWindow[];
  details: Array<{ label: string; value: string }>;
}

export interface UsageReport {
  timezone: string;
  priceVersion: number;
  days: UsageDayRow[];
  calendarDays: UsageCalendarDay[];
  totals: {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    usdEstimate: number;
  };
  live: LiveUsageSnapshot[];
  notes: string[];
}

export interface ImproveReport {
  candidates: number;
  clusters: number;
  promoted: number;
  suggestions: number;
  usedRemoteLlm: boolean;
}

export interface ApplyResult {
  ok: boolean;
  suggestionId: string;
  targetFile: string;
  backupPath?: string;
  error?: string;
}

export interface HealthReport {
  dbPath: string;
  sessions: number;
  turns: number;
  candidates: number;
  suggestions: number;
  integrations: IntegrationHealth[];
}

export interface Settings {
  improveEnabled: boolean;
  improveGlobalRules: boolean;
  hooksAutoInstall: boolean;
}

export interface SidecarApi {
  health: () => Promise<HealthReport>;
  ingest: () => Promise<IngestReport>;
  usage: (days?: number) => Promise<UsageReport>;
  sessions: () => Promise<SessionRecord[]>;
  setup: () => Promise<SetupItemRecord[]>;
  candidates: (limit?: number) => Promise<CandidateRecord[]>;
  clusters: () => Promise<ClusterRecord[]>;
  suggestions: () => Promise<SuggestionRecord[]>;
  runImprove: () => Promise<ImproveReport>;
  applySuggestion: (id: string) => Promise<ApplyResult>;
  undoSuggestion: (id: string) => Promise<ApplyResult>;
  dismissSuggestion: (id: string) => Promise<void>;
  settings: () => Promise<Settings>;
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  hooksStatus: () => Promise<HookStatus[]>;
  installHooks: () => Promise<HookStatus[]>;
  uninstallHooks: () => Promise<HookStatus[]>;
}

export interface SidecarShell {
  setPinned: (pinned: boolean) => Promise<void>;
  hidePanel: () => Promise<void>;
  quitApp: () => Promise<void>;
  openInEditor: (session: SessionRecord) => Promise<OpenResult>;
  openInTerminal: (session: SessionRecord) => Promise<OpenResult>;
}

export interface OpenResult {
  ok: boolean;
  opened: string | null;
  error: string | null;
}
