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
  activity?: string | null;
  lastRole?: TurnRole | null;
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
}

export interface SidecarShell {
  setPinned: (pinned: boolean) => Promise<void>;
  hidePanel: () => Promise<void>;
  quitApp: () => Promise<void>;
}
