import { createHash } from "node:crypto";
import { parse } from "pg-connection-string";
import type { Queryable, Row } from "./db.js";
import type { Seed } from "./model.js";
import type { SubsetOptions } from "./plan.js";

/**
 * Sync checkpoints, kept in the target database's `_tributary` schema so
 * a resume works from any machine, and so a table's checkpoint commits in
 * the same transaction as its rows.
 */
export const STATE_SCHEMA = "_tributary";

export type RunStatus = "in_progress" | "completed" | "failed";

function sha256(...parts: string[]): string {
  const h = createHash("sha256");
  for (const part of parts) h.update(part).update("\0");
  return h.digest("hex");
}

/**
 * What identifies "the same sync" across invocations: where from, which
 * seeds, which schema file contents, which traversal options.
 */
export function runId(sourceUrl: string, seeds: Seed[], options: Required<SubsetOptions>): string {
  const c = parse(sourceUrl);
  const source = `${c.host ?? "localhost"}:${c.port ?? 5432}/${c.database ?? ""}`;
  const { schema, traversal, strictCycles } = options;
  return sha256(
    source,
    JSON.stringify(seeds),
    JSON.stringify({
      relations: canonical(schema.relations),
      breaks: canonical(schema.cycleBreaks),
      traversal,
      strictCycles,
    }),
  ).slice(0, 16);
}

/**
 * What a list of relations or breaks means, independent of how the file
 * spelled it: no declaration locations, in a fixed order. Reordering keys
 * or qualifying names in the schema file keeps the same run id.
 */
function canonical(items: { at?: string }[]): string[] {
  return items.map(({ at: _, ...meaning }) => JSON.stringify(meaning)).sort();
}

/**
 * A fingerprint of the rows a table is about to receive. A resumed run
 * only skips a table whose checkpoint has the same fingerprint, so source
 * changes since the interrupted run are never silently left out.
 */
export function rowsFingerprint(rows: ReadonlyMap<string, Row>): string {
  const keys = [...rows.keys()].sort();
  return sha256(...keys.map((k) => JSON.stringify([k, rows.get(k)])));
}

export async function ensureStateSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS ${STATE_SCHEMA};
    CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.runs (
      run_id         text PRIMARY KEY,
      status         text NOT NULL,
      failure_reason text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      completed_at   timestamptz
    );
    CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA}.run_tables (
      run_id           text NOT NULL REFERENCES ${STATE_SCHEMA}.runs ON DELETE CASCADE,
      table_name       text NOT NULL,
      rows_fingerprint text NOT NULL,
      rows_upserted    bigint NOT NULL,
      completed_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, table_name)
    );`);
}

/**
 * Starts or resumes run `id`. An unfinished run (in progress or failed)
 * resumes, keeping its table checkpoints, unless `fresh`; a completed or
 * fresh run starts over.
 */
export async function startRun(db: Queryable, id: string, fresh: boolean): Promise<void> {
  const { rows } = await db.query(`SELECT status FROM ${STATE_SCHEMA}.runs WHERE run_id = $1`, [
    id,
  ]);
  const status = rows[0]?.status as RunStatus | undefined;
  if (status === undefined) {
    await db.query(`INSERT INTO ${STATE_SCHEMA}.runs (run_id, status) VALUES ($1, 'in_progress')`, [
      id,
    ]);
    return;
  }
  if (status === "completed" || fresh) {
    await db.query(`DELETE FROM ${STATE_SCHEMA}.run_tables WHERE run_id = $1`, [id]);
  }
  await db.query(
    `UPDATE ${STATE_SCHEMA}.runs SET status = 'in_progress', failure_reason = NULL, completed_at = NULL WHERE run_id = $1`,
    [id],
  );
}

/** Table -> fingerprint of the rows it was loaded with, for this run's completed tables. */
export async function completedTables(db: Queryable, id: string): Promise<Map<string, string>> {
  const { rows } = await db.query(
    `SELECT table_name, rows_fingerprint FROM ${STATE_SCHEMA}.run_tables WHERE run_id = $1`,
    [id],
  );
  return new Map(rows.map((r) => [r.table_name!, r.rows_fingerprint!]));
}

/** Call inside the table's load transaction. */
export async function markTableDone(
  db: Queryable,
  id: string,
  table: string,
  fingerprint: string,
  rowsUpserted: number,
): Promise<void> {
  await db.query(
    `INSERT INTO ${STATE_SCHEMA}.run_tables (run_id, table_name, rows_fingerprint, rows_upserted) VALUES ($1, $2, $3, $4)
     ON CONFLICT (run_id, table_name) DO UPDATE SET rows_fingerprint = EXCLUDED.rows_fingerprint,
       rows_upserted = EXCLUDED.rows_upserted, completed_at = now()`,
    [id, table, fingerprint, rowsUpserted],
  );
}

export async function finishRun(db: Queryable, id: string, failure?: string): Promise<void> {
  const status: RunStatus = failure === undefined ? "completed" : "failed";
  await db.query(
    `UPDATE ${STATE_SCHEMA}.runs SET status = $2, failure_reason = $3,
       completed_at = CASE WHEN $2 = 'completed' THEN now() END
     WHERE run_id = $1`,
    [id, status, failure ?? null],
  );
}
