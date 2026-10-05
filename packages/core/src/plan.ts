import type { ForeignKey, Schema } from "./catalog.js";
import { type AppliedBreak, type Closure, computeClosure } from "./closure.js";
import { type ProjectConfig, parseProjectConfig, type Seed } from "./config.js";
import { connect, type Queryable, readOnly } from "./db.js";
import { buildGraph, type Graph, type NodeId } from "./graph.js";
import { inspect } from "./inspect.js";
import { deferredColumns, deferredForeignKeys } from "./load.js";
import { tableOrder } from "./order.js";

export interface PlanOptions {
  /** Source connection string. */
  source: string;
  seeds: Seed[];
  config?: ProjectConfig;
}

/** The subset to load, and everything derived from the source needed to load it. */
export interface Subset {
  schema: Schema;
  graph: Graph;
  closure: Closure;
  /** Tables with rows, in load order. */
  order: NodeId[];
  /** FK constraints loaded NULL first and backfilled; see deferredForeignKeys. */
  deferred: Map<NodeId, ForeignKey[]>;
}

/**
 * Inspects the source and computes the subset. Call inside readOnly() so
 * every query sees one snapshot and nothing can write to the source.
 */
export async function computeSubset(
  source: Queryable,
  seeds: Seed[],
  config: ProjectConfig,
): Promise<Subset> {
  const schema = await inspect(source);
  const graph = buildGraph(schema, config);
  const closure = await computeClosure(source, graph, seeds, config);
  const deferred = deferredForeignKeys(schema, graph, closure, config.dependencyBreaks);
  const order = tableOrder(schema, closure.rows.keys(), deferredColumns(deferred));
  return { schema, graph, closure, order, deferred };
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
    const { graph, closure, order } = await readOnly(source, () =>
      computeSubset(source, options.seeds, config),
    );
    const seedTables = new Set(options.seeds.map((s) => s.table));
    const tables = order.map((table): PlanTable => {
      const cycleBreak = closure.breaks.find((b) => b.table === table);
      return {
        table,
        rows: closure.rows.get(table)!.size,
        via: seedTables.has(table) ? "seed" : via(graph, closure, table),
        ...(cycleBreak && { break: cycleBreak }),
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

/** Describes one edge by which `table`'s rows were reached. */
function via(graph: Graph, closure: Closure, table: NodeId): string {
  for (const e of graph.incoming(table)) {
    if (closure.rows.has(e.from)) {
      return `${e.from}.${e.fromColumns.join(",")} -> ${table}.${e.toColumns.join(",")}`;
    }
  }
  for (const { edge, typeValue } of graph.polymorphicIncoming(table)) {
    if (closure.rows.has(edge.from)) {
      return `${edge.from}.${edge.typeColumn} -> ${table} (polymorphic: ${typeValue})`;
    }
  }
  for (const e of graph.outgoing(table)) {
    if (e.kind === "fixed" && closure.rows.has(e.to)) {
      return `${table}.${e.fromColumns.join(",")} -> ${e.to}.${e.toColumns.join(",")}`;
    }
  }
  return "?";
}
