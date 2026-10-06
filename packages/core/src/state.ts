import { createHash } from "node:crypto";
import { parse } from "pg-connection-string";
import type { Queryable } from "./db.js";
import type { Seed } from "./model.js";
import type { SubsetOptions } from "./plan.js";

/**
 * A log of sync runs, kept in the target database's `_tributary` schema:
 * when each ran and how it ended. There are no per-table checkpoints: a
 * re-run after a failure streams every table again, and the merge writes
 * nothing for rows that are already there and unchanged.
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
    -- Per-table checkpoints from versions before 0.2.
    DROP TABLE IF EXISTS ${STATE_SCHEMA}.run_tables;`);
}

/** Records run `id` as in progress (a re-run of the same sync reuses its id). */
export async function startRun(db: Queryable, id: string): Promise<void> {
  await db.query(
    `INSERT INTO ${STATE_SCHEMA}.runs (run_id, status) VALUES ($1, 'in_progress')
     ON CONFLICT (run_id) DO UPDATE SET status = 'in_progress', failure_reason = NULL,
       created_at = now(), completed_at = NULL`,
    [id],
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
