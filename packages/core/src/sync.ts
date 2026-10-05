import { createHash } from "node:crypto";
import { parse } from "pg-connection-string";
import type { Schema } from "./catalog.js";
import { tableId } from "./catalog.js";
import { type AppliedBreak, type Closure, computeClosure } from "./closure.js";
import { type ProjectConfig, parseProjectConfig, type Seed } from "./config.js";
import { connect, type Queryable } from "./db.js";
import { ensureSchema, type SchemaReport } from "./ddl.js";
import { buildGraph, type Graph, type NodeId } from "./graph.js";
import { assertDistinctDatabases, checkTargetAllowed } from "./guards.js";
import { inspect } from "./inspect.js";
import {
  backfill,
  checkDeferrable,
  deferredColumns,
  deferredForeignKeys,
  deleteRows,
  explainLoadError,
  upsertRows,
} from "./load.js";
import { tableOrder } from "./order.js";
import {
  completedTables,
  ensureStateSchema,
  finishRun,
  markTableDone,
  startRun,
} from "./state.js";

export interface PlanOptions {
  /** Source connection string. */
  source: string;
  seed: Seed;
  config?: ProjectConfig;
}

export interface SubsetPlan {
  schema: Schema;
  graph: Graph;
  closure: Closure;
  /** Tables with rows, in load order. */
  order: NodeId[];
}

/**
 * Inspects the source and computes the subset, all inside one READ ONLY
 * REPEATABLE READ transaction: a consistent snapshot across tables, and
 * nothing in the seed predicate can write to the source.
 */
async function computePlan(
  source: Queryable,
  seed: Seed,
  config: ProjectConfig,
): Promise<SubsetPlan> {
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const schema = await inspect(source);
    const graph = buildGraph(schema, config);
    const closure = await computeClosure(source, graph, seed, config);
    const deferred = deferredColumns(
      deferredForeignKeys(schema, graph, closure, config.dependencyBreaks),
    );
    const order = tableOrder(schema, closure.rows.keys(), deferred);
    return { schema, graph, closure, order };
  } finally {
    await source.query("ROLLBACK");
  }
}

export interface PlanTable {
  table: NodeId;
  rows: number;
  /** How the table was reached, e.g. "seed" or "public.orders.user_id -> public.users.id". */
  via: string;
  break?: AppliedBreak;
}

export interface PlanResult {
  tables: PlanTable[];
  totalRows: number;
  breaks: AppliedBreak[];
  warnings: string[];
}

/** Computes the subset without writing anything: per-table row counts in load order. */
export async function plan(options: PlanOptions): Promise<PlanResult> {
  const config = options.config ?? parseProjectConfig({});
  const source = await connect(options.source);
  try {
    const { graph, closure, order } = await computePlan(
      source,
      options.seed,
      config,
    );
    const tables = order.map((table): PlanTable => {
      const rows = closure.rows.get(table)!.size;
      const brk = closure.breaks.find((b) => b.table === table);
      return {
        table,
        rows,
        via: via(graph, closure, table, options.seed.table),
        ...(brk && { break: brk }),
      };
    });
    return {
      tables,
      totalRows: tables.reduce((n, t) => n + t.rows, 0),
      breaks: closure.breaks,
      warnings: closure.warnings,
    };
  } finally {
    await source.end();
  }
}

function via(
  graph: Graph,
  closure: Closure,
  table: NodeId,
  seed: NodeId,
): string {
  if (table === seed) return "seed";
  for (const e of graph.incoming(table)) {
    if (closure.rows.has(e.from))
      return `${e.from}.${e.fromColumns.join(",")} -> ${table}.${e.toColumns.join(",")}`;
  }
  for (const { edge, typeValue } of graph.polymorphicIncoming(table)) {
    if (closure.rows.has(edge.from))
      return `${edge.from}.${edge.typeColumn} -> ${table} (polymorphic: ${typeValue})`;
  }
  for (const e of graph.outgoing(table)) {
    if (e.kind === "fixed" && closure.rows.has(e.to)) {
      return `${table}.${e.fromColumns.join(",")} -> ${e.to}.${e.toColumns.join(",")}`;
    }
  }
  return "?";
}

export interface SyncOptions extends PlanOptions {
  /** Target connection string. */
  target: string;
  /**
   * Hosts the target may be on ("localhost", "*.staging.internal"). Empty
   * denies every target; pass ["*"]-style entries only deliberately.
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
  /** Already loaded by an earlier, interrupted run of the same sync. */
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
    target = await connect(options.target);
    await assertDistinctDatabases(source, target);
    const { schema, graph, closure, order } = await computePlan(
      source,
      options.seed,
      config,
    );
    return await load(
      target,
      { ...options, config },
      { schema, graph, closure, order },
    );
  } finally {
    await Promise.all([source.end(), target?.end()]);
  }
}

async function load(
  target: Queryable,
  options: SyncOptions & { config: ProjectConfig },
  { schema, graph, closure, order }: SubsetPlan,
): Promise<SyncResult> {
  const { config } = options;
  const tables = new Map(schema.tables.map((t) => [tableId(t), t]));
  const deferredFks = deferredForeignKeys(
    schema,
    graph,
    closure,
    config.dependencyBreaks,
  );
  const deferred = deferredColumns(deferredFks);
  checkDeferrable(schema, deferredFks);

  const report = await ensureSchema(
    target,
    schema,
    order,
    options.createSchema ?? true,
  );
  await ensureStateSchema(target);
  const runId = await startRun(
    target,
    {
      source: fingerprint(options.source),
      seedTable: options.seed.table,
      seedWhere: options.seed.where,
      configHash: hashConfig(config),
    },
    options.fresh ?? false,
  );

  try {
    if (options.fresh) {
      await transaction(target, async () => {
        for (const id of [...order].reverse()) {
          await deleteRows(target, tables.get(id)!, [
            ...closure.rows.get(id)!.values(),
          ]);
        }
      });
    }

    const done = await completedTables(target, runId);
    const results: SyncTable[] = [];
    for (const id of order) {
      const result: SyncTable = {
        table: id,
        rowsUpserted: 0,
        rowsBackfilled: 0,
        rowsLeftNull: 0,
        resumed: done.has(id),
      };
      results.push(result);
      if (result.resumed) continue;
      await transaction(target, async () => {
        try {
          result.rowsUpserted = await upsertRows(
            target,
            tables.get(id)!,
            [...closure.rows.get(id)!.values()],
            deferred.get(id),
          );
        } catch (e) {
          throw explainLoadError(e, id);
        }
        await markTableDone(target, runId, id, result.rowsUpserted);
      });
    }

    await transaction(target, async () => {
      for (const result of results) {
        const fks = deferredFks.get(result.table);
        if (!fks) continue;
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
    return {
      runId,
      tables: results,
      totalRows: results.reduce((n, t) => n + t.rowsUpserted, 0),
      schema: report,
      breaks: closure.breaks,
      warnings: [...closure.warnings, ...report.warnings],
    };
  } catch (e) {
    await finishRun(
      target,
      runId,
      e instanceof Error ? e.message : String(e),
    ).catch(() => {});
    throw e;
  }
}

async function transaction(
  db: Queryable,
  fn: () => Promise<void>,
): Promise<void> {
  await db.query("BEGIN");
  try {
    await fn();
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** Where a connection string points, without credentials. */
function fingerprint(url: string): string {
  const c = parse(url);
  return `${c.host ?? "localhost"}:${c.port ?? 5432}/${c.database ?? ""}`;
}

function hashConfig(config: ProjectConfig): string {
  const { relations, dependencyBreaks, traversal, strictCycles } = config;
  return createHash("sha256")
    .update(
      JSON.stringify({ relations, dependencyBreaks, traversal, strictCycles }),
    )
    .digest("hex");
}
