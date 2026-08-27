import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CandidateRecord,
  ClusterRecord,
  Harness,
  HealthReport,
  LiveUsageSnapshot,
  LiveUsageStatus,
  SessionRecord,
  SetupItemRecord,
  SetupKind,
  SetupSource,
  SuggestionRecord,
  UsageReport,
  UsageWindow,
} from "@shared/types";
import {
  AgentsIcon,
  BellIcon,
  HarnessMark,
  ImproveIcon,
  PinIcon,
  SetupIcon,
  SidecarMark,
  UsageIcon,
} from "./icons";
import { installPreviewBridge } from "./preview";

type Tab = "agents" | "setup" | "usage" | "improve";

const USAGE_MIN_REFRESH_MS = 15_000;
const SCROLL_IDLE_MS = 160;

export default function App() {
  const [tab, setTab] = useState<Tab>("agents");
  const [pinned, setPinned] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [setup, setSetup] = useState<SetupItemRecord[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [candidates, setCandidates] = useState<CandidateRecord[]>([]);
  const [clusters, setClusters] = useState<ClusterRecord[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionRecord[]>([]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const usageFetchedAtRef = useRef(0);
  const scrollingRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshAgents = useCallback(async () => {
    const [nextHealth, nextSessions] = await Promise.all([
      window.sidecar.health(),
      window.sidecar.sessions(),
    ]);
    setHealth(nextHealth);
    setSessions(nextSessions);
  }, []);

  const refreshTab = useCallback(async (nextTab: Tab) => {
    switch (nextTab) {
      case "agents":
        await refreshAgents();
        return;
      case "setup":
        setSetup(await window.sidecar.setup());
        return;
      case "usage":
        setUsage(await window.sidecar.usage(30));
        usageFetchedAtRef.current = Date.now();
        return;
      case "improve": {
        const [nextCandidates, nextClusters, nextSuggestions] = await Promise.all([
          window.sidecar.candidates(40),
          window.sidecar.clusters(),
          window.sidecar.suggestions(),
        ]);
        setCandidates(nextCandidates);
        setClusters(nextClusters);
        setSuggestions(nextSuggestions);
        return;
      }
      default: {
        const exhaustive: never = nextTab;
        return exhaustive;
      }
    }
  }, [refreshAgents]);

  const refreshCurrentTab = useCallback(() => {
    const current = tabRef.current;
    if (current === "usage" && Date.now() - usageFetchedAtRef.current < USAGE_MIN_REFRESH_MS) {
      return;
    }
    void refreshTab(current).catch((err: unknown) => setError(String(err)));
  }, [refreshTab]);

  const handleBodyScroll = useCallback(() => {
    scrollingRef.current = true;
    if (scrollEndTimerRef.current) {
      clearTimeout(scrollEndTimerRef.current);
    }
    scrollEndTimerRef.current = setTimeout(() => {
      scrollingRef.current = false;
      scrollEndTimerRef.current = null;
      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false;
        refreshCurrentTab();
      }
    }, SCROLL_IDLE_MS);
  }, [refreshCurrentTab]);

  useEffect(() => {
    if (!window.sidecar || !window.sidecarEvents) {
      if (import.meta.env.DEV) {
        installPreviewBridge();
      } else {
        setError("Renderer bridge missing. Restart npm run dev.");
        return;
      }
    }
    void refreshAgents().catch((err: unknown) => setError(String(err)));
    void refreshTab("usage").catch((err: unknown) => setError(String(err)));
    return window.sidecarEvents.onChanged(() => {
      if (scrollingRef.current) {
        queuedRefreshRef.current = true;
        return;
      }
      refreshCurrentTab();
    });
  }, [refreshAgents, refreshCurrentTab, refreshTab]);

  useEffect(() => {
    return () => {
      if (scrollEndTimerRef.current) {
        clearTimeout(scrollEndTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (tab !== "agents") {
      void refreshTab(tab).catch((err: unknown) => setError(String(err)));
    }
  }, [refreshTab, tab]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen((open) => {
          if (open) {
            setQuery("");
            return false;
          }
          void window.sidecarShell.hidePanel();
          return open;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const proposed = suggestions.filter((item) => item.status === "proposed").length;
  const attention = sessions.filter((item) => item.state === "needs_attention" || item.hasBlocking);

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await Promise.all([refreshAgents(), refreshTab(tab)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <button
          className={`icon-btn ${pinned ? "active" : ""}`}
          title="Keep open"
          type="button"
          onClick={() => {
            const next = !pinned;
            setPinned(next);
            void window.sidecarShell.setPinned(next);
          }}
        >
          <PinIcon />
        </button>
        <div className="brand">
          Sidecar
          <SidecarMark className="flower" />
        </div>
        <button
          className="icon-btn"
          type="button"
          title="Needs attention"
          onClick={() => setTab("agents")}
        >
          <BellIcon />
          {attention.length > 0 && <span className="badge">{attention.length}</span>}
        </button>
      </header>

      <nav className="tabs" aria-label="Sidecar surfaces">
        <TabButton id="agents" tab={tab} onClick={setTab} label="Agents" icon={<AgentsIcon />} />
        <TabButton id="setup" tab={tab} onClick={setTab} label="Setup" icon={<SetupIcon />} />
        <TabButton id="usage" tab={tab} onClick={setTab} label="Usage" icon={<UsageIcon />} />
        <TabButton
          id="improve"
          tab={tab}
          onClick={setTab}
          label="Improve"
          icon={<ImproveIcon />}
          badge={proposed}
        />
      </nav>

      <main className="body" onScroll={handleBodyScroll}>
        {error && <div className="empty">{error}</div>}
        {tab === "agents" && (
          <AgentsView
            sessions={sessions}
            query={query}
            searchOpen={searchOpen}
            onQuery={setQuery}
          />
        )}
        {tab === "setup" && <SetupView items={setup} />}
        {tab === "usage" && <UsageView usage={usage} />}
        {tab === "improve" && (
          <ImproveView
            busy={busy}
            candidates={candidates}
            clusters={clusters}
            suggestions={suggestions}
            onRun={() => void run(() => window.sidecar.runImprove())}
            onApply={(id) => void run(() => window.sidecar.applySuggestion(id))}
            onUndo={(id) => void run(() => window.sidecar.undoSuggestion(id))}
            onDismiss={(id) => void run(() => window.sidecar.dismissSuggestion(id))}
          />
        )}
      </main>

      <footer className="footer">
        <div className="integrations">
          {(["claude", "codex", "cursor"] as const).map((harness) => {
            const status = health?.integrations.find((item) => item.harness === harness)?.status;
            return (
              <span
                key={harness}
                className={`integration ${status === "ok" ? "ok" : ""}`}
                title={`${providerLabel(harness)}: ${status ?? "offline"}`}
              >
                <HarnessMark harness={harness} />
                {harness === "claude" ? "Claude" : providerLabel(harness)}
              </span>
            );
          })}
        </div>
        <button className="kbd" type="button" onClick={() => setSearchOpen(true)}>
          ⌘F
        </button>
      </footer>
    </div>
  );
}

function AgentsView({
  sessions,
  query,
  searchOpen,
  onQuery,
}: {
  sessions: SessionRecord[];
  query: string;
  searchOpen: boolean;
  onQuery: (value: string) => void;
}) {
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = needle
      ? sessions.filter((session) =>
          [session.activity, session.cwd, session.gitBranch, session.harness, session.title]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : sessions;
    const needs = rows.filter((session) => session.state === "needs_attention" || session.hasBlocking);
    const running = rows.filter(
      (session) => session.state === "active" && !session.hasBlocking && !session.isSidechain,
    );
    const subagents = rows.filter(
      (session) => session.state === "active" && !session.hasBlocking && session.isSidechain,
    );
    return { needs, running, subagents };
  }, [sessions, query]);

  return (
    <>
      {searchOpen && (
        <input
          autoFocus
          className="search"
          placeholder="Search agents, repos, branches"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      )}
      {filtered.needs.length > 0 && (
        <Section title="Needs you">
          {filtered.needs.map((session) => (
            <AgentCard key={session.id} session={session} attention />
          ))}
        </Section>
      )}
      <Section title="Running">
        {filtered.running.length === 0 ? (
          <EmptyState
            title="No agents running"
            body="Sidecar is watching Claude Code, Codex, and Cursor on this machine."
          />
        ) : (
          filtered.running.map((session) => <AgentCard key={session.id} session={session} />)
        )}
      </Section>
      {filtered.subagents.length > 0 && (
        <Section title="Subagents">
          {filtered.subagents.map((session) => (
            <AgentCard key={session.id} session={session} />
          ))}
        </Section>
      )}
    </>
  );
}

function AgentCard({ session, attention = false }: { session: SessionRecord; attention?: boolean }) {
  const status =
    session.state === "needs_attention" || session.hasBlocking
      ? "waiting"
      : session.isSidechain
        ? "subagent"
        : session.state === "active"
          ? "working"
          : "idle";
  return (
    <article className={`card ${attention ? "attention" : ""}`}>
      <div className="agent-card-top">
        <span className={`harness-badge ${session.harness}`}>
          <HarnessMark harness={session.harness} />
          {providerLabel(session.harness)}
        </span>
        <span className="agent-time">{relativeTime(session.lastTs)}</span>
      </div>
      <p className="card-title">{session.activity || session.title || session.nativeId.slice(0, 8)}</p>
      <div className="meta">
        <span>{repoLabel(session)}</span>
        <span className={`status-pill ${status}`}>{status}</span>
        <span className={`spin ${session.state === "active" ? "" : "idle"}`} />
      </div>
    </article>
  );
}

const SetupView = memo(function SetupView({ items }: { items: SetupItemRecord[] }) {
  const [kind, setKind] = useState<"all" | SetupKind>("all");
  const [source, setSource] = useState<"all" | SetupSource>("all");
  const sources = useMemo(
    () => [...new Set(items.map((item) => item.harness))].sort((a, b) => setupSourceLabel(a).localeCompare(setupSourceLabel(b))),
    [items],
  );
  const visible = items.filter(
    (item) => (kind === "all" || item.kind === kind) && (source === "all" || item.harness === source),
  );
  const groups = useMemo(() => {
    const order: SetupKind[] = ["skill", "mcp", "rule", "hook", "agent", "plugin", "plan"];
    const map = new Map<SetupKind, SetupItemRecord[]>();
    for (const item of visible) {
      const list = map.get(item.kind) ?? [];
      list.push(item);
      map.set(item.kind, list);
    }
    return [...map.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([groupKind, rows]) => [
        groupKind,
        rows.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "")),
      ] as const);
  }, [visible]);
  const skillCount = items.filter((item) => item.kind === "skill").length;
  const mcpCount = items.filter((item) => item.kind === "mcp").length;

  return (
    <>
      <div className="setup-summary">
        <button type="button" onClick={() => setKind("skill")}>
          <strong>{skillCount}</strong>
          <span>Skills</span>
        </button>
        <button type="button" onClick={() => setKind("mcp")}>
          <strong>{mcpCount}</strong>
          <span>MCP servers</span>
        </button>
      </div>
      <div className="chips">
        {(["all", "skill", "mcp", "rule", "hook"] as const).map((id) => (
          <button
            key={id}
            className={`chip ${kind === id ? "active" : ""}`}
            type="button"
            onClick={() => setKind(id)}
          >
            {id === "all" ? "All" : id === "mcp" ? "MCPs" : setupKindLabel(id)}
          </button>
        ))}
      </div>
      <select
        className="source-select"
        value={source}
        onChange={(event) => setSource(event.target.value as "all" | SetupSource)}
        aria-label="Filter setup by agent"
      >
        <option value="all">All agents</option>
        {sources.map((id) => (
          <option key={id} value={id}>{setupSourceLabel(id)}</option>
        ))}
      </select>
      <p className="muted setup-count">{visible.length} configured items</p>
      {groups.map(([groupKind, rows]) => (
        <section key={groupKind}>
          <Section title={`${setupKindLabel(groupKind)} · ${rows.length}`} />
          {rows.map((item) => (
            <div className="setup-item" key={item.id} title={item.path.split("#")[0]}>
              <span className={`setup-kind ${item.kind}`}>{setupKindGlyph(item.kind)}</span>
              <div className="setup-copy">
                <div className="setup-name">
                  <strong>{item.title || "Untitled"}</strong>
                  <span>{setupSourceLabel(item.harness)} · {item.scope}</span>
                </div>
                <p>{item.preview || pathLabel(item.path)}</p>
              </div>
            </div>
          ))}
        </section>
      ))}
      {visible.length === 0 && (
        <EmptyState
          title="Nothing indexed yet"
          body="Sidecar reads skills, rules, hooks, and MCP servers from Claude Code, Codex, Cursor, and the other agents on disk."
        />
      )}
    </>
  );
});

function setupSourceLabel(source: SetupSource): string {
  switch (source) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "antigravity":
      return "Antigravity";
    case "cline":
      return "Cline";
    case "cline-cli":
      return "Cline CLI";
    case "claude-desktop":
      return "Claude Desktop";
    case "fx":
      return "fx";
    case "gemini-cli":
      return "Gemini CLI";
    case "goose":
      return "Goose";
    case "github-copilot-cli":
      return "GitHub Copilot CLI";
    case "grok-build":
      return "Grok Build";
    case "kilo-code":
      return "Kilo Code";
    case "kimi-code":
      return "Kimi Code";
    case "kiro-cli":
      return "Kiro CLI";
    case "mcporter":
      return "MCPorter";
    case "opencode":
      return "OpenCode";
    case "universal":
      return "Universal";
    case "vscode":
      return "VS Code";
    case "windsurf":
      return "Windsurf";
    case "zed":
      return "Zed";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function setupKindLabel(kind: SetupKind): string {
  switch (kind) {
    case "skill":
      return "Skills";
    case "mcp":
      return "MCP servers";
    case "rule":
      return "Rules";
    case "hook":
      return "Hooks";
    case "agent":
      return "Agents";
    case "plugin":
      return "Plugins";
    case "plan":
      return "Plans";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function setupKindGlyph(kind: SetupKind): string {
  switch (kind) {
    case "skill":
      return "✦";
    case "mcp":
      return "↗";
    case "rule":
      return "§";
    case "hook":
      return "⌁";
    case "agent":
      return "◉";
    case "plugin":
      return "◇";
    case "plan":
      return "✓";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function pathLabel(value: string): string {
  return value.split("#")[0]?.split("/").filter(Boolean).slice(-2).join("/") ?? value;
}

function UsageView({ usage }: { usage: UsageReport | null }) {
  const byHarness = useMemo(() => {
    if (!usage) {
      return [];
    }
    const map = new Map<Harness, { harness: Harness; usd: number }>();
    for (const row of usage.days) {
      const current = map.get(row.harness) ?? { harness: row.harness, usd: 0 };
      current.usd += row.usdEstimate;
      map.set(row.harness, current);
    }
    return [...map.values()];
  }, [usage]);
  const byDay = usage?.calendarDays.slice(0, 14) ?? [];

  if (!usage) {
    return (
      <EmptyState
        title="Loading usage"
        body="Reading local token history and live plan windows for Claude Code, Codex, and Cursor."
      />
    );
  }

  return (
    <>
      <Section title="Plan" />
      {usage.live.length === 0 && (
        <p className="muted usage-note">
          Live plan windows appear when Claude Code, Codex, or Cursor is already signed in on this Mac.
        </p>
      )}
      {usage.live.map((snapshot) => (
        <LiveUsageCard key={snapshot.provider} snapshot={snapshot} />
      ))}
      <Section title="Spend" />
      <div className="card spend-hero">
        <p className="card-title">{fmtUsd(usage.totals.usdEstimate)}</p>
        <div className="muted">Last 30 days · {usage.timezone}</div>
      </div>
      {byHarness.map((row) => (
        <div className="usage-row" key={row.harness}>
          <span className={`harness-badge ${row.harness}`}>
            <HarnessMark harness={row.harness} />
            {providerLabel(row.harness)}
          </span>
          <span>{fmtUsd(row.usd)}</span>
        </div>
      ))}
      <Section title="By day" />
      {byDay.map((row) => (
        <div className="usage-row" key={row.day}>
          <span>{formatDayLabel(row.day)}</span>
          <span>{fmtUsd(row.usdEstimate)}</span>
        </div>
      ))}
      {byDay.length === 0 && <div className="muted usage-note">No local token events in this window.</div>}
    </>
  );
}

function LiveUsageCard({ snapshot }: { snapshot: LiveUsageSnapshot }) {
  const status = liveStatusLabel(snapshot.status);
  return (
    <div className="card usage-live">
      <div className="usage-live-head">
        <span className={`harness-badge ${snapshot.provider}`}>
          <HarnessMark harness={snapshot.provider} />
          {providerLabel(snapshot.provider)}
          {snapshot.plan ? <span className="muted">· {snapshot.plan}</span> : null}
        </span>
        <span className={`usage-status ${snapshot.status}`}>{status}</span>
      </div>
      {snapshot.windows.length === 0 && snapshot.error && <p className="muted">{snapshot.error}</p>}
      {snapshot.windows.map((window) => (
        <UsageMeter key={window.label} window={window} />
      ))}
      {snapshot.details.map((detail) => (
        <div className="usage-row" key={detail.label}>
          <span>{detail.label}</span>
          <span className="muted">{detail.value}</span>
        </div>
      ))}
    </div>
  );
}

function UsageMeter({ window }: { window: UsageWindow }) {
  const remainingPct = window.limit > 0 ? clampPct(((window.limit - window.used) / window.limit) * 100) : 0;
  const low = remainingPct <= 10;
  return (
    <div className="usage-meter-row">
      <div className="usage-row">
        <span>{window.label}</span>
        <span>
          {formatWindowRemaining(window)}
          {window.resetsAt ? <span className="muted"> · {fmtReset(window.resetsAt)}</span> : null}
        </span>
      </div>
      <div className={`usage-meter${low ? " high" : ""}`}>
        <span style={{ width: `${remainingPct}%` }} />
      </div>
    </div>
  );
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatWindowRemaining(window: UsageWindow): string {
  const remaining = Math.max(0, window.limit - window.used);
  switch (window.unit) {
    case "percent":
      return `${Math.round(clampPct(remaining))}% left`;
    case "usd":
      return `${fmtUsd(remaining)} left of ${fmtUsd(window.limit)}`;
    case "count":
      return `${Math.round(remaining)} left of ${Math.round(window.limit)}`;
    default: {
      const exhaustive: never = window.unit;
      return exhaustive;
    }
  }
}

function liveStatusLabel(status: LiveUsageStatus): string {
  switch (status) {
    case "ok":
      return "Live";
    case "stale":
      return "Stale";
    case "rate_limited":
      return "Rate limited";
    case "unauthenticated":
      return "Not signed in";
    case "unavailable":
      return "Unavailable";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p>{body}</p>
    </div>
  );
}

function providerLabel(harness: Harness): string {
  switch (harness) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    default: {
      const exhaustive: never = harness;
      return exhaustive;
    }
  }
}

function fmtReset(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) {
    return "";
  }
  if (ms <= 0) {
    return "resetting";
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `resets in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `resets in ${hours}h`;
  }
  return `resets in ${Math.round(hours / 24)}d`;
}

function ImproveView({
  busy,
  candidates,
  clusters,
  suggestions,
  onRun,
  onApply,
  onUndo,
  onDismiss,
}: {
  busy: boolean;
  candidates: CandidateRecord[];
  clusters: ClusterRecord[];
  suggestions: SuggestionRecord[];
  onRun: () => void;
  onApply: (id: string) => void;
  onUndo: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <>
      <Section title="Suggestions">
        <button className="btn primary" disabled={busy} onClick={onRun} type="button">
          Scan corrections
        </button>
        <p className="muted usage-note">Looks through Claude Code, Codex, and Cursor transcripts. Nothing leaves this Mac.</p>
      </Section>
      {suggestions.length === 0 && (
        <EmptyState
          title="No rule diffs yet"
          body="Sidecar promotes a correction after it repeats across three sessions, from any of the agents."
        />
      )}
      {suggestions.map((suggestion) => (
        <article className="card" key={suggestion.id}>
          <p className="card-title">{suggestion.targetFile.split("/").slice(-2).join("/")}</p>
          <p className="muted">{suggestion.rationale}</p>
          <pre>{suggestion.diff}</pre>
          <div className="row">
            {suggestion.status === "proposed" && (
              <button className="btn primary" disabled={busy} onClick={() => onApply(suggestion.id)} type="button">
                Apply
              </button>
            )}
            {suggestion.status === "applied" && (
              <button className="btn" disabled={busy} onClick={() => onUndo(suggestion.id)} type="button">
                Undo
              </button>
            )}
            <button className="btn danger" disabled={busy} onClick={() => onDismiss(suggestion.id)} type="button">
              Dismiss
            </button>
          </div>
        </article>
      ))}
      <Section title="Candidates" />
      {candidates.slice(0, 8).map((candidate) => (
        <div className="setup-row" key={candidate.turnId}>
          <span>{candidate.text.slice(0, 72)}</span>
          <span className="muted">{candidate.score.toFixed(0)}</span>
        </div>
      ))}
      {clusters.filter((cluster) => cluster.status === "promoted").length === 0 && (
        <p className="muted">Clusters stay hidden until they repeat across 3 sessions.</p>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <div className="section-head">
        {title.toUpperCase()}
        <i className="rule" />
      </div>
      {children}
    </>
  );
}

function TabButton({
  id,
  tab,
  onClick,
  label,
  icon,
  badge,
}: {
  id: Tab;
  tab: Tab;
  onClick: (tab: Tab) => void;
  label: string;
  icon: ReactNode;
  badge?: number;
}) {
  return (
    <button className={`tab ${tab === id ? "active" : ""}`} type="button" onClick={() => onClick(id)}>
      {icon}
      <span className="tab-label">{label}</span>
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );
}

function repoLabel(session: SessionRecord): string {
  const repo = session.cwd?.split("/").filter(Boolean).at(-1);
  if (repo && session.gitBranch) {
    return session.worktree ? `${repo} (${session.gitBranch})` : `${repo}`;
  }
  return repo ?? session.harness;
}

function relativeTime(ts: string | null): string {
  if (!ts) {
    return "";
  }
  const delta = Date.now() - Date.parse(ts);
  if (!Number.isFinite(delta) || delta < 0) {
    return "";
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatDayLabel(day: string): string {
  const parts = day.split("-");
  const year = parts[0];
  const month = parts[1];
  const date = parts[2];
  if (!year || !month || !date) {
    return day;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = Number(month) - 1;
  const label = months[monthIndex];
  if (!label) {
    return day;
  }
  return `${date} ${label} ${year}`;
}

