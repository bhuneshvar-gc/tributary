import { tableId } from "./catalog.js";
import type { AppliedBreak } from "./closure.js";
import { type ProjectConfig, parseProjectConfig } from "./config.js";
import { connect, type Queryable, readOnly, transaction } from "./db.js";
import { ensureSchema, type SchemaReport } from "./ddl.js";
import type { NodeId } from "./graph.js";
import { assertDifferentDatabases, checkTargetAllowed, databaseIdentity } from "./guards.js";
import { backfill, checkDeferrable, deferredColumns, deleteRows, explainLoadError, upsertRows } from "./load.js";
import { computeSubset, type PlanOptions, type Subset } from "./plan.js";
import {
  completedTables,
  ensureStateSchema,
  finishRun,
  markTableDone,
  rowsFingerprint,
  runId as runIdFor,
  startRun,
} from "./state.js";

export interface SyncOptions extends PlanOptions {
  /** Target connection string. */
  target: string;
  /**
   * Hosts the target may be on ("localhost", "*.staging.internal"). Empty
   * denies every target, so each environment needs an explicit opt-in.
   */
  allowlist: readonly string[];
  /** Delete the subset's rows from target before loading, and restart instead of resuming. */
  fresh?: boolean;
  /** Create missing target tables (default true); false makes a missing table an error. */
  createSchema?: boolean;
}

export interface SyncTable {
  table: NodeId;
  rowsUpserted: number;
  rowsBackfilled: number;
  rowsLeftNull: number;
  /** Already loaded, with the same rows, by an earlier interrupted run of the same sync. */
  resumed: boolean;
}

export interface SyncResult {
  runId: string;
  tables: SyncTable[];
  totalRows: number;
  schema: SchemaReport;
  breaks: AppliedBreak[];
  warnings: string[];
}

/**
 * Copies the referentially-consistent subset from source into target:
 * creates missing tables, upserts each table's rows in its own
 * transaction (checkpointed in the same transaction, so an interrupted
 * run resumes where it stopped), then backfills deferred FK columns.
 */
export async function sync(options: SyncOptions): Promise<SyncResult> {
  checkTargetAllowed(options.target, options.allowlist);
  const config = options.config ?? parseProjectConfig({});
  const source = await connect(options.source);
  let target: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const targetClient = await connect(options.target);
    target = targetClient;
    const targetIdentity = await databaseIdentity(targetClient);
    const subset = await readOnly(source, async () => {
      assertDifferentDatabases(await databaseIdentity(source), targetIdentity);
      return computeSubset(source, options.seeds, config);
    });
    return await load(targetClient, { ...options, config }, subset);
  } finally {
    await Promise.all([source.end(), target?.end()]);
  }
}

async function load(
  target: Queryable,
  options: SyncOptions & { config: ProjectConfig },
  { schema, closure, order, deferred }: Subset,
): Promise<SyncResult> {
  const tables = new Map(schema.tables.map((t) => [tableId(t), t]));
  const rowsOf = (id: NodeId) => [...closure.rows.get(id)!.values()];
  const deferredByTable = deferredColumns(deferred);
  checkDeferrable(schema, deferred);

  const report = await ensureSchema(target, schema, order, options.createSchema ?? true);
  await ensureStateSchema(target);
  const runId = runIdFor(options.source, options.seeds, options.config);
  await startRun(target, runId, options.fresh ?? false);

  try {
    if (options.fresh) {
      await transaction(target, async () => {
        for (const id of [...order].reverse()) await deleteRows(target, tables.get(id)!, rowsOf(id));
      });
    }

    const done = await completedTables(target, runId);
    const results: SyncTable[] = [];
    for (const id of order) {
      const fingerprint = rowsFingerprint(closure.rows.get(id)!);
      const result: SyncTable = {
        table: id,
        rowsUpserted: 0,
        rowsBackfilled: 0,
        rowsLeftNull: 0,
        resumed: done.get(id) === fingerprint,
      };
      results.push(result);
      if (result.resumed) continue;
      await transaction(target, async () => {
        try {
          result.rowsUpserted = await upsertRows(target, tables.get(id)!, rowsOf(id), deferredByTable.get(id));
        } catch (e) {
          throw explainLoadError(e, id);
        }
        await markTableDone(target, runId, id, fingerprint, result.rowsUpserted);
      });
    }

    await transaction(target, async () => {
      for (const result of results) {
        const fks = deferred.get(result.table);
        if (!fks) continue;
        const { backfilled, leftNull } = await backfill(target, tables.get(result.table)!, fks, closure);
        result.rowsBackfilled = backfilled;
        result.rowsLeftNull = leftNull;
      }
    });

    await finishRun(target, runId);
    return {
      runId,
      tables: results,
      totalRows: results.reduce((n, t) => n + t.rowsUpserted, 0),
      schema: report,
      breaks: closure.breaks,
      warnings: [...closure.warnings, ...report.warnings],
    };
  } catch (e) {
    await finishRun(target, runId, e instanceof Error ? e.message : String(e)).catch(() => {});
    throw e;
  }
}
