import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";

interface Migration {
  version: number;
  statements: string[];
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
