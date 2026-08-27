export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_file (
  path TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  inode TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL DEFAULT 1,
  watermark TEXT
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  cwd TEXT,
  git_branch TEXT,
  worktree INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  started_at TEXT,
  ended_at TEXT,
  last_ts TEXT,
  state TEXT NOT NULL DEFAULT 'unknown',
  has_blocking INTEGER NOT NULL DEFAULT 0,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  UNIQUE (harness, native_id)
);

CREATE TABLE IF NOT EXISTS turn (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT,
  text TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  permission_mode TEXT,
  prevented_continuation INTEGER NOT NULL DEFAULT 0,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  cursor_rules_json TEXT,
  parent_id TEXT,
  is_user_prompt INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, source_event_id),
  FOREIGN KEY (session_id) REFERENCES session(id)
);

CREATE INDEX IF NOT EXISTS idx_turn_session_ts ON turn(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_turn_prompt ON turn(is_user_prompt, ts);
CREATE INDEX IF NOT EXISTS idx_turn_session_prompt_ts ON turn(session_id, is_user_prompt, ts DESC);
CREATE INDEX IF NOT EXISTS idx_turn_session_role_ts ON turn(session_id, role, ts DESC);

CREATE TABLE IF NOT EXISTS usage_event (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  source_event_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  UNIQUE (harness, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_event(ts);
CREATE INDEX IF NOT EXISTS idx_usage_harness_ts ON usage_event(harness, ts);

CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  harness TEXT NOT NULL,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_event_id TEXT NOT NULL,
  UNIQUE (harness, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_event_session_type_ts ON event(session_id, type, ts);

CREATE TABLE IF NOT EXISTS candidate (
  turn_id TEXT PRIMARY KEY,
  signals_json TEXT NOT NULL,
  score REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES turn(id)
);

CREATE TABLE IF NOT EXISTS cluster (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL DEFAULT 0,
  distinct_sessions INTEGER NOT NULL DEFAULT 0,
  distinct_tasks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cluster_membership (
  cluster_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (cluster_id, turn_id, version),
  FOREIGN KEY (cluster_id) REFERENCES cluster(id),
  FOREIGN KEY (turn_id) REFERENCES turn(id)
);

CREATE TABLE IF NOT EXISTS suggestion (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  target_file TEXT NOT NULL,
  diff TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  base_hash TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  backup_path TEXT,
  applied_hash TEXT,
  FOREIGN KEY (cluster_id) REFERENCES cluster(id)
);

CREATE TABLE IF NOT EXISTS analysis_run (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  prompt_version TEXT,
  input_hash TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_item (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  scope TEXT NOT NULL,
  mtime_ms INTEGER,
  hash TEXT,
  preview TEXT,
  UNIQUE (harness, kind, path)
);

CREATE TABLE IF NOT EXISTS integration_health (
  harness TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_ok_at TEXT,
  lag_ms INTEGER,
  parse_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
`;
