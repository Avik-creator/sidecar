import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/migrate.js";
import { SCHEMA_SQL } from "../src/core/db/schema.js";
import { Store } from "../src/core/db/store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-migrate-"));
  tmpDirs.push(dir);
  return dir;
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe("schema migrations", () => {
  it("brings a fresh database fully up to date", () => {
    const store = Store.open(path.join(tmp(), "db.sqlite"));
    const versions = (
      store.db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{
        version: number;
      }>
    ).map((row) => row.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
    expect(columns(store.db, "session")).toContain("hook_ts");
    expect(columns(store.db, "session")).toContain("hook_event");
    expect(columns(store.db, "session")).toContain("parent_id");
    expect(columns(store.db, "session")).toContain("agent_type");
    expect(columns(store.db, "session")).toContain("state_source");
    expect(columns(store.db, "session")).toContain("pid");
    expect(columns(store.db, "session")).toContain("last_hook_ts");
    expect(columns(store.db, "session")).toContain("last_tool");
    expect(columns(store.db, "session")).toContain("lines_removed");
    store.close();
  });

  it("backfills hook provenance onto sessions that already reported", () => {
    const file = path.join(tmp(), "provenance.sqlite");
    const first = Store.open(file);
    first.db.exec(`DELETE FROM schema_migrations WHERE version = 5`);
    first.db.exec(`ALTER TABLE session DROP COLUMN state_source`);
    first.db.exec(`ALTER TABLE session DROP COLUMN pid`);
    first.db.exec(`ALTER TABLE session DROP COLUMN last_hook_ts`);
    first.db.exec(
      `INSERT INTO session(id, harness, native_id, state, hook_ts) VALUES
         ('claude:a', 'claude', 'a', 'active', '2026-09-01T00:00:00Z'),
         ('claude:b', 'claude', 'b', 'unknown', NULL)`,
    );
    first.close();

    const store = Store.open(file);
    const rows = store.db
      .prepare(`SELECT id, state_source, last_hook_ts FROM session ORDER BY id`)
      .all() as Array<{ id: string; state_source: string | null; last_hook_ts: string | null }>;
    expect(rows).toEqual([
      { id: "claude:a", state_source: "hook", last_hook_ts: "2026-09-01T00:00:00Z" },
      { id: "claude:b", state_source: null, last_hook_ts: null },
    ]);
    store.close();
  });

  it("clears the subagent rows that used to land on their parent", () => {
    const file = path.join(tmp(), "sidechains.sqlite");
    const first = Store.open(file);
    first.db.exec(`DELETE FROM schema_migrations WHERE version = 4`);
    first.db.exec(
      `INSERT INTO session(id, harness, native_id, is_sidechain) VALUES ('claude:s1', 'claude', 's1', 1)`,
    );
    first.db.exec(
      `INSERT INTO turn(id, session_id, source_event_id, role, ts, is_sidechain)
       VALUES ('t1', 'claude:s1', 'e1', 'user', '2026-01-01T00:00:00Z', 1),
              ('t2', 'claude:s1', 'e2', 'user', '2026-01-01T00:00:01Z', 0)`,
    );
    first.db.exec(
      `INSERT INTO source_file(path, harness) VALUES
         ('/p/abc/subagents/agent-x.jsonl', 'claude'), ('/p/abc.jsonl', 'claude')`,
    );
    first.close();

    const store = Store.open(file);
    const turns = store.db.prepare(`SELECT id FROM turn`).all() as Array<{ id: string }>;
    const files = store.db.prepare(`SELECT path FROM source_file`).all() as Array<{ path: string }>;
    const session = store.db.prepare(`SELECT is_sidechain FROM session`).get() as { is_sidechain: number };
    // The sidechain turn is dropped so re-ingest can rewrite it onto the subagent's own row.
    expect(turns.map((row) => row.id)).toEqual(["t2"]);
    // Only the subagent transcript is re-read; the parent's offset survives.
    expect(files.map((row) => row.path)).toEqual(["/p/abc.jsonl"]);
    expect(session.is_sidechain).toBe(0);
    store.close();
  });

  it("upgrades a pre-migration database without losing rows", () => {
    const file = path.join(tmp(), "legacy.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO session(id, harness, native_id, cwd, state) VALUES ('claude:a', 'claude', 'a', '/tmp', 'active')`,
      )
      .run();
    expect(columns(legacy, "session")).not.toContain("hook_ts");
    legacy.close();

    const store = Store.open(file);
    expect(columns(store.db, "session")).toContain("hook_ts");
    expect(columns(store.db, "session")).toContain("hook_event");
    const row = store.db.prepare(`SELECT id, hook_ts FROM session`).get() as {
      id: string;
      hook_ts: string | null;
    };
    expect(row.id).toBe("claude:a");
    expect(row.hook_ts).toBeNull();
    store.close();
  });

  it("is idempotent across repeated opens", () => {
    const file = path.join(tmp(), "db.sqlite");
    for (let i = 0; i < 3; i += 1) {
      const store = Store.open(file);
      store.close();
    }
    const db = new DatabaseSync(file);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(count.n).toBe(6);
    db.close();
  });

  it("drops the unread event table and keeps everything else", () => {
    const file = path.join(tmp(), "withevents.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(SCHEMA_SQL);
    legacy.exec(`CREATE TABLE event (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      harness TEXT NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      source_event_id TEXT NOT NULL,
      UNIQUE (harness, source_event_id)
    )`);
    legacy
      .prepare(`INSERT INTO session(id, harness, native_id, cwd, state) VALUES ('claude:a', 'claude', 'a', '/tmp', 'active')`)
      .run();
    legacy
      .prepare(`INSERT INTO event(harness, type, ts, source_event_id) VALUES ('claude', 'x', '2026-01-01T00:00:00Z', 'e1')`)
      .run();
    legacy.close();

    const store = Store.open(file);
    const tables = (
      store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).not.toContain("event");
    expect(tables).toContain("session");
    const kept = store.db.prepare(`SELECT COUNT(*) AS n FROM session`).get() as { n: number };
    expect(kept.n).toBe(1);
    store.close();
  });

  it("tolerates a database that already has the added column", () => {
    const file = path.join(tmp(), "half.sqlite");
    const db = new DatabaseSync(file);
    db.exec(SCHEMA_SQL);
    db.exec(`ALTER TABLE session ADD COLUMN hook_ts TEXT`);
    db.close();
    const reopened = new DatabaseSync(file);
    expect(() => migrate(reopened)).not.toThrow();
    reopened.close();
  });
});
