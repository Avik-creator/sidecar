import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";

interface Migration {
  version: number;
  statements: string[];
  // VACUUM cannot run inside a transaction, so it happens after the commit.
  vacuum?: boolean;
}

// Version 1 is the baseline schema. Later versions only add to it.
const MIGRATIONS: Migration[] = [
  {
    version: 2,
    statements: [
      `ALTER TABLE session ADD COLUMN hook_ts TEXT`,
      `ALTER TABLE session ADD COLUMN hook_event TEXT`,
    ],
  },
  {
    version: 3,
    statements: [`DROP TABLE IF EXISTS event`],
    vacuum: true,
  },
  {
    version: 4,
    statements: [
      `ALTER TABLE session ADD COLUMN parent_id TEXT`,
      `ALTER TABLE session ADD COLUMN agent_type TEXT`,
      // Subagent turns landed on the parent row, so its flag was whichever file ingested last.
      `UPDATE session SET is_sidechain = 0`,
      // Both are derived from turns and rebuilt by Improve, so they go before the turns they cite.
      `DELETE FROM cluster_membership WHERE turn_id IN (SELECT id FROM turn WHERE is_sidechain = 1)`,
      `DELETE FROM candidate WHERE turn_id IN (SELECT id FROM turn WHERE is_sidechain = 1)`,
      `DELETE FROM turn WHERE is_sidechain = 1`,
      // Re-reads only the subagent transcripts, so those turns come back on their own rows.
      `DELETE FROM source_file WHERE path LIKE '%/subagents/%'`,
      // Cursor keeps one watermark for the whole store, so its subagents need a full re-read.
      `UPDATE source_file SET watermark = '0' WHERE harness = 'cursor'`,
    ],
  },
  {
    version: 5,
    statements: [
      `ALTER TABLE session ADD COLUMN state_source TEXT`,
      `ALTER TABLE session ADD COLUMN pid INTEGER`,
      // Kept separately so a native reader overwriting hook_ts cannot hide that a hook once fired.
      `ALTER TABLE session ADD COLUMN last_hook_ts TEXT`,
      `UPDATE session SET state_source = 'hook', last_hook_ts = hook_ts WHERE hook_ts IS NOT NULL`,
    ],
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const applied = new Set(
    (db.prepare(`SELECT version FROM schema_migrations`).all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  const record = db.prepare(
    `INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)`,
  );
  if (!applied.has(1)) {
    record.run(1, new Date().toISOString());
    applied.add(1);
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) {
        if (isAlreadyApplied(db, statement)) {
          continue;
        }
        db.exec(statement);
      }
      record.run(migration.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (migration.vacuum) {
      db.exec("VACUUM");
    }
  }
}

// A database written by a newer build may already carry a column this version adds.
function isAlreadyApplied(db: DatabaseSync, statement: string): boolean {
  const match = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(statement.trim());
  if (!match) {
    return false;
  }
  const [, table, column] = match;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}
