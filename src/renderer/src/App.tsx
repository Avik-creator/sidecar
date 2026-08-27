import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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

type Tab = "agents" | "setup" | "usage" | "improve";

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

  useEffect(() => {
    if (!window.sidecar || !window.sidecarEvents) {
      setError("Renderer bridge missing. Restart npm run dev.");
      return;
    }
    void refreshAgents().catch((err: unknown) => setError(String(err)));
    return window.sidecarEvents.onChanged(() => {
      void refreshAgents().catch((err: unknown) => setError(String(err)));
    });
  }, [refreshAgents]);

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
          sidecar
          <svg className="flower" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="2" fill="currentColor" />
            <circle cx="8" cy="3.2" r="2" fill="currentColor" />
            <circle cx="8" cy="12.8" r="2" fill="currentColor" />
            <circle cx="3.2" cy="8" r="2" fill="currentColor" />
            <circle cx="12.8" cy="8" r="2" fill="currentColor" />
          </svg>
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

      <main className="body">
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
              <span key={harness} className={status === "ok" ? "ok" : "muted"} title={`${harness}: ${status ?? "unknown"}`}>
                <i className={`harness ${harness}`} /> {shortHarness(harness)}
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
          <div className="empty">No agents running right now.</div>
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
  return (
    <article className={`card ${attention ? "attention" : ""}`}>
      <p className="card-title">{session.activity || session.title || session.nativeId.slice(0, 8)}</p>
      <div className="meta">
        <i className={`harness ${session.harness}`} />
        <span>{repoLabel(session)}</span>
        <span>{relativeTime(session.lastTs)}</span>
        <span>
          {session.state === "needs_attention"
            ? "waiting"
            : session.isSidechain
              ? "subagent"
              : session.state === "active"
                ? "working"
                : session.harness}
        </span>
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
      {visible.length === 0 && <div className="empty">No setup files indexed yet. Ingest first.</div>}
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
    const map = new Map<string, { harness: string; usd: number; tokensIn: number; tokensOut: number }>();
    for (const row of usage.days) {
      const current = map.get(row.harness) ?? { harness: row.harness, usd: 0, tokensIn: 0, tokensOut: 0 };
      current.usd += row.usdEstimate;
      current.tokensIn += row.tokensIn;
      current.tokensOut += row.tokensOut;
      map.set(row.harness, current);
    }
    return [...map.values()];
  }, [usage]);

  if (!usage) {
    return <div className="empty">Usage appears after ingest.</div>;
  }

  return (
    <>
      <Section title="Plan" />
      {usage.live.length === 0 && <div className="muted usage-note">Live plan windows appear after a signed-in agent is found.</div>}
      {usage.live.map((snapshot) => (
        <LiveUsageCard key={snapshot.provider} snapshot={snapshot} />
      ))}
      <Section title="Spend" />
      <div className="card">
        <p className="card-title">{fmtUsd(usage.totals.usdEstimate)}</p>
        <div className="muted">Last 30 days · {usage.timezone} · price table v{usage.priceVersion}</div>
      </div>
      {byHarness.map((row) => (
        <div className="usage-row" key={row.harness}>
          <span className="row">
            <i className={`harness ${row.harness}`} />
            {row.harness}
          </span>
          <span>{fmtUsd(row.usd)}</span>
        </div>
      ))}
      <Section title="By day" />
      {usage.days
        .slice()
        .reverse()
        .slice(0, 18)
        .map((row) => (
          <div className="usage-row" key={`${row.day}-${row.harness}-${row.model}`}>
            <span>
              {row.day.slice(5)} · {row.model}
            </span>
            <span>{fmtUsd(row.usdEstimate)}</span>
          </div>
        ))}
      {usage.notes.length > 0 && (
        <p className="muted usage-note">{usage.notes.join(" ")}</p>
      )}
    </>
  );
}

function LiveUsageCard({ snapshot }: { snapshot: LiveUsageSnapshot }) {
  const status = liveStatusLabel(snapshot.status);
  return (
    <div className="card usage-live">
      <div className="usage-live-head">
        <span className="row">
          <i className={`harness ${snapshot.provider}`} />
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
      {snapshot.unofficial && <div className="muted usage-unofficial">Unofficial API</div>}
    </div>
  );
}

function UsageMeter({ window }: { window: UsageWindow }) {
  const pct = window.limit > 0 ? Math.min(100, Math.max(0, (window.used / window.limit) * 100)) : 0;
  const high = pct >= 90;
  return (
    <div className="usage-meter-row">
      <div className="usage-row">
        <span>{window.label}</span>
        <span>
          {formatWindowUsed(window)}
          {window.resetsAt ? <span className="muted"> · {fmtReset(window.resetsAt)}</span> : null}
        </span>
      </div>
      <div className={`usage-meter${high ? " high" : ""}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatWindowUsed(window: UsageWindow): string {
  switch (window.unit) {
    case "percent":
      return `${Math.round(window.used)}%`;
    case "usd":
      return `${fmtUsd(window.used)} / ${fmtUsd(window.limit)}`;
    case "count":
      return `${Math.round(window.used)} / ${Math.round(window.limit)}`;
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

function providerLabel(harness: Harness): string {
  switch (harness) {
    case "claude":
      return "Claude";
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
      </Section>
      {suggestions.length === 0 && <div className="empty">Nothing promoted yet. Need 3 distinct sessions.</div>}
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

function shortHarness(harness: "claude" | "codex" | "cursor"): string {
  switch (harness) {
    case "claude":
      return "CC";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    default: {
      const never: never = harness;
      return never;
    }
  }
}

function AgentsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <circle cx="6" cy="9" r="0.8" fill="currentColor" />
      <circle cx="10" cy="9" r="0.8" fill="currentColor" />
      <path d="M6 3.5h4" />
    </svg>
  );
}

function SetupIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3 5h10M5 8h8M3 11h10" />
    </svg>
  );
}

function UsageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="5" />
      <path d="M8 8h4" />
    </svg>
  );
}

function ImproveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 2a4 4 0 0 1 2.5 7c-.4.4-.5.8-.5 1.3V12H6v-1.7c0-.5-.1-.9-.5-1.3A4 4 0 0 1 8 2z" />
      <path d="M6.5 13h3" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M7 15 8.5 9H13l-3-6H6L3 9h4.5L7 15z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 7a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4z" />
      <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}
