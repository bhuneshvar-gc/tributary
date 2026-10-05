import { createHash } from "node:crypto";
import type { Queryable } from "./db.js";

/**
 * Sync checkpoints, kept in the target database's `_tributary` schema so
 * a resume works from any machine, and so a table's checkpoint commits in
 * the same transaction as its rows.
 */
export const STATE_SCHEMA = "_tributary";

/** What identifies "the same sync" across invocations. */
export interface RunKey {
  source: string;
  seedTable: string;
  seedWhere: string;
  configHash: string;
}

export function runId(key: RunKey): string {
  const h = createHash("sha256");
  for (const part of [key.source, key.seedTable, key.seedWhere, key.configHash])
    h.update(part).update("\0");
  return h.digest("hex").slice(0, 16);
}

export async function ensureStateSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS ${STATE_SCHEMA};
    CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.runs (
      run_id         text PRIMARY KEY,
      source         text NOT NULL,
      seed_table     text NOT NULL,
      seed_where     text NOT NULL,
      config_hash    text NOT NULL,
      status         text NOT NULL,
      failure_reason text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      completed_at   timestamptz
    );
    CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.run_tables (
      run_id        text NOT NULL REFERENCES ${STATE_SCHEMA}.runs ON DELETE CASCADE,
      table_name    text NOT NULL,
      rows_upserted bigint NOT NULL,
      completed_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, table_name)
    );`);
}

/**
 * Starts or resumes the run for `key`. An unfinished run (in progress or
 * failed) resumes, keeping its completed tables, unless `fresh`; a
 * completed or fresh run starts over.
 */
export async function startRun(
  db: Queryable,
  key: RunKey,
  fresh: boolean,
): Promise<string> {
  const id = runId(key);
  const { rows } = await db.query(
    `SELECT status FROM ${STATE_SCHEMA}.runs WHERE run_id = $1`,
    [id],
  );
  const status = rows[0]?.status;
  if (status === undefined) {
    await db.query(
      `INSERT INTO ${STATE_SCHEMA}.runs (run_id, source, seed_table, seed_where, config_hash, status) VALUES ($1, $2, $3, $4, $5, 'in_progress')`,
      [id, key.source, key.seedTable, key.seedWhere, key.configHash],
    );
    return id;
  }
  if (status === "completed" || fresh) {
    await db.query(`DELETE FROM ${STATE_SCHEMA}.run_tables WHERE run_id = $1`, [
      id,
    ]);
  }
  await db.query(
    `UPDATE ${STATE_SCHEMA}.runs SET status = 'in_progress', failure_reason = NULL, completed_at = NULL WHERE run_id = $1`,
    [id],
  );
  return id;
}

export async function completedTables(
  db: Queryable,
  id: string,
): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT table_name FROM ${STATE_SCHEMA}.run_tables WHERE run_id = $1`,
    [id],
  );
  return new Set(rows.map((r) => r.table_name!));
}

/** Call inside the table's load transaction. */
export async function markTableDone(
  db: Queryable,
  id: string,
  table: string,
  rows: number,
): Promise<void> {
  await db.query(
    `INSERT INTO ${STATE_SCHEMA}.run_tables (run_id, table_name, rows_upserted) VALUES ($1, $2, $3)
     ON CONFLICT (run_id, table_name) DO UPDATE SET rows_upserted = EXCLUDED.rows_upserted, completed_at = now()`,
    [id, table, rows],
  );
}

export async function finishRun(
  db: Queryable,
  id: string,
  failure?: string,
): Promise<void> {
  await db.query(
    failure === undefined
      ? `UPDATE ${STATE_SCHEMA}.runs SET status = 'completed', completed_at = now() WHERE run_id = $1`
      : `UPDATE ${STATE_SCHEMA}.runs SET status = 'failed', failure_reason = $2 WHERE run_id = $1`,
    failure === undefined ? [id] : [id, failure],
  );
}
