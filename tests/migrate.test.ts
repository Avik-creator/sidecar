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
    expect(versions).toEqual([1, 2, 3]);
    expect(columns(store.db, "session")).toContain("hook_ts");
    expect(columns(store.db, "session")).toContain("hook_event");
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
    expect(count.n).toBe(3);
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
