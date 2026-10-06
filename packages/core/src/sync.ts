import type pg from "pg";
import { tableId } from "./catalog.js";
import type { AppliedBreak } from "./closure.js";
import { streamRows } from "./copy.js";
import { connect, ident, type Queryable, qualified, readOnly, transaction } from "./db.js";
import { ensureSchema, type SchemaReport } from "./ddl.js";
import type { NodeId } from "./graph.js";
import { assertDifferentDatabases, checkTargetAllowed, databaseIdentity } from "./guards.js";
import {
  backfill,
  checkDeferrable,
  deferredColumns,
  deleteRows,
  explainLoadError,
  mergeStaged,
} from "./load.js";
import { computeSubset, type PlanOptions, type Subset, subsetDefaults } from "./plan.js";
import { ensureStateSchema, finishRun, runId as runIdFor, startRun } from "./state.js";

export interface SyncOptions extends PlanOptions {
  /** Target connection string. */
  target: string;
  /**
   * Hosts the target may be on ("localhost", "*.staging.internal"). Empty
   * denies every target, so each environment needs an explicit opt-in.
   */
  allowlist: readonly string[];
  /** Delete the subset's rows from target before loading them. */
  fresh?: boolean;
  /** Create missing target tables (default true); false makes a missing table an error. */
  createSchema?: boolean;
}

export interface SyncTable {
  table: NodeId;
  /**
   * "new table": created by this sync and empty, so rows were copied
   * straight in. "upsert": rows were staged, then merged on the primary key.
   */
  mode: "new table" | "upsert";
  /** Rows inserted or updated. */
  rowsWritten: number;
  /** Rows already on the target with the same values: not rewritten. */
  rowsUnchanged: number;
  rowsBackfilled: number;
  rowsLeftNull: number;
}

export interface SyncResult {
  runId: string;
  tables: SyncTable[];
  /** Rows inserted or updated across all tables. */
  totalRows: number;
  schema: SchemaReport;
  breaks: AppliedBreak[];
  warnings: string[];
  /** Wall-clock time the sync took. */
  durationMs: number;
}

/**
 * Copies the referentially-consistent subset from source into target.
 *
 * The subset is computed holding only key columns, then each table's full
 * rows stream COPY-to-COPY from source to target, never parsed in Node and
 * read in the same snapshot the subset was computed in. A table this sync
 * created is copied straight in; any other is staged and merged on its
 * primary key, rewriting only rows that changed. Deferred foreign keys are
 * backfilled after every table is in, and loaded tables are analyzed.
 */
export async function sync(options: SyncOptions): Promise<SyncResult> {
  const started = performance.now();
  checkTargetAllowed(options.target, options.allowlist);
  const source = await connect(options.source);
  let target: pg.Client | undefined;
  try {
    const targetClient = await connect(options.target);
    target = targetClient;
    const targetIdentity = await databaseIdentity(targetClient);
    // One read-only snapshot for computing the subset and streaming its
    // rows, ended as soon as the last row is copied: an open transaction
    // holds back vacuum on the source.
    const copied = await readOnly(source, async () => {
      assertDifferentDatabases(await databaseIdentity(source), targetIdentity);
      const subset = await computeSubset(source, options.seeds, options);
      return copyTables(source, targetClient, options, subset);
    });
    const result = await finish(targetClient, options, copied);
    return { ...result, durationMs: performance.now() - started };
  } finally {
    await Promise.all([source.end(), target?.end()]);
  }
}

/** A transaction on the target that doesn't wait for its WAL to be flushed on commit. */
function writeTransaction<T>(target: Queryable, fn: () => Promise<T>): Promise<T> {
  return transaction(target, async () => {
    // Safe for any user: a crash can lose the last moments of commits, never corrupt data.
    await target.query("SET LOCAL synchronous_commit = off");
    return fn();
  });
}

/** A sync whose rows are all on the target, with deferred FKs still to backfill. */
interface Copied {
  runId: string;
  results: SyncTable[];
  subset: Subset;
  report: SchemaReport;
}

/** Creates missing tables, records the run, and copies every table's rows in. */
async function copyTables(
  source: pg.Client,
  target: pg.Client,
  options: SyncOptions,
  subset: Subset,
): Promise<Copied> {
  const { catalog, closure, order, deferred } = subset;
  const tables = new Map(catalog.tables.map((t) => [tableId(t), t]));
  const keysOf = (id: NodeId) => [...closure.rows.get(id)!.values()];
  const deferredByTable = deferredColumns(deferred);
  checkDeferrable(catalog, deferred);
  const progress = subsetDefaults(options).onProgress;

  progress({ phase: "preparing" });
  const report = await ensureSchema(target, catalog, order, options.createSchema ?? true);
  const created = new Set(report.tablesCreated);
  await ensureStateSchema(target);
  const runId = runIdFor(options.source, options.seeds, subsetDefaults(options));
  await startRun(target, runId);

  try {
    if (options.fresh) {
      progress({ phase: "deleting", tables: order.length });
      await writeTransaction(target, async () => {
        for (const id of [...order].reverse())
          await deleteRows(target, tables.get(id)!, keysOf(id));
      });
    }

    const results: SyncTable[] = [];
    for (const [index, id] of order.entries()) {
      const step = { table: id, index: index + 1, total: order.length };
      const totalRows = closure.rows.get(id)!.size;
      progress({ phase: "copying", rows: 0, totalRows, ...step });
      const t = tables.get(id)!;
      const stream = {
        nulled: deferredByTable.get(id) ?? new Set<string>(),
        onRows: (rows: number) => progress({ phase: "copying", rows, totalRows, ...step }),
      };
      const result: SyncTable = {
        table: id,
        mode: created.has(id) ? "new table" : "upsert",
        rowsWritten: 0,
        rowsUnchanged: 0,
        rowsBackfilled: 0,
        rowsLeftNull: 0,
      };
      results.push(result);
      try {
        await writeTransaction(target, async () => {
          if (result.mode === "new table") {
            result.rowsWritten = await streamRows(
              source,
              target,
              t,
              keysOf(id),
              qualified(id),
              stream,
            );
            return;
          }
          await target.query(
            `CREATE TEMP TABLE tributary_stage ON COMMIT DROP AS SELECT ${t.columns.map((c) => ident(c.name)).join(", ")} FROM ${qualified(id)} WITH NO DATA`,
          );
          const staged = await streamRows(source, target, t, keysOf(id), "tributary_stage", stream);
          progress({ phase: "merging", rows: staged, ...step });
          result.rowsWritten = await mergeStaged(target, t, "tributary_stage", stream.nulled);
          result.rowsUnchanged = staged - result.rowsWritten;
        });
      } catch (e) {
        throw explainLoadError(e, id);
      }
      progress({
        phase: "loaded",
        ...step,
        mode: result.mode,
        written: result.rowsWritten,
        unchanged: result.rowsUnchanged,
      });
    }

    return { runId, results, subset, report };
  } catch (e) {
    await finishRun(target, runId, e instanceof Error ? e.message : String(e)).catch(() => {});
    throw e;
  }
}

/** Backfills deferred FKs, closes the run, and refreshes statistics. */
async function finish(
  target: pg.Client,
  options: SyncOptions,
  { runId, results, subset, report }: Copied,
): Promise<Omit<SyncResult, "durationMs">> {
  const { catalog, closure, deferred } = subset;
  const progress = subsetDefaults(options).onProgress;
  const tables = new Map(catalog.tables.map((t) => [tableId(t), t]));
  const warnings = [...closure.warnings, ...report.warnings];
  try {
    await writeTransaction(target, async () => {
      const toBackfill = results.filter((r) => deferred.has(r.table));
      for (const [index, result] of toBackfill.entries()) {
        const fks = deferred.get(result.table)!;
        progress({
          phase: "backfilling",
          table: result.table,
          index: index + 1,
          total: toBackfill.length,
        });
        const { backfilled, leftNull } = await backfill(
          target,
          tables.get(result.table)!,
          fks,
          closure,
        );
        result.rowsBackfilled = backfilled;
        result.rowsLeftNull = leftNull;
      }
    });

    await finishRun(target, runId);
  } catch (e) {
    await finishRun(target, runId, e instanceof Error ? e.message : String(e)).catch(() => {});
    throw e;
  }

  // Fresh planner statistics for tables that changed. The data is already
  // committed, so a failure here is a warning, not a failed sync.
  const changed = results.filter((r) => r.rowsWritten + r.rowsBackfilled > 0);
  for (const [index, result] of changed.entries()) {
    progress({ phase: "analyzing", table: result.table, index: index + 1, total: changed.length });
    await target.query(`ANALYZE ${qualified(result.table)}`).catch((e: unknown) => {
      warnings.push(
        `could not analyze ${result.table}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  return {
    runId,
    tables: results,
    totalRows: results.reduce((n, t) => n + t.rowsWritten, 0),
    schema: report,
    breaks: closure.breaks,
    warnings,
  };
}
