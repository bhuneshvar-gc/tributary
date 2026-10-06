import type { ForeignKey, Schema } from "./catalog.js";
import { type AppliedBreak, type Closure, computeClosure } from "./closure.js";
import { connect, type Queryable, readOnly } from "./db.js";
import { buildGraph, type Graph, type NodeId } from "./graph.js";
import { inspect } from "./inspect.js";
import { deferredColumns, deferredForeignKeys } from "./load.js";
import type { Seed, Traversal } from "./model.js";
import { tableOrder } from "./order.js";
import { emptySchemaFile, type SchemaFile } from "./schema-file.js";

/** How the subset is computed, beyond where it starts. */
export interface SubsetOptions {
  /** Relations, ignores and cycle breaks the catalog can't tell (see loadSchemaFile). */
  schema?: SchemaFile;
  /** Default "downstream"; see TRAVERSALS. */
  traversal?: Traversal;
  /** Fail on a foreign key cycle with no breakCycle entry instead of auto-breaking it. */
  strictCycles?: boolean;
  /** Called as the work advances, e.g. to show progress. */
  onProgress?: (event: SubsetProgress) => void;
}

/** Where a table is in a sync's load: its position among the tables loaded. */
interface TableStep {
  table: NodeId;
  /** 1-based. */
  index: number;
  total: number;
}

/** What a plan or sync is doing right now. */
export type SubsetProgress =
  | { phase: "inspecting" }
  | { phase: "collecting"; rows: number; tables: number }
  /** Checking the target's tables, creating missing ones. */
  | { phase: "preparing" }
  /** --fresh: deleting the subset's rows from the target. */
  | { phase: "deleting"; tables: number }
  /** Streaming a table's rows from source to target: `rows` so far, of `totalRows`. */
  | ({ phase: "copying"; rows: number; totalRows: number } & TableStep)
  /** Merging a table's staged rows into it. */
  | ({ phase: "merging"; rows: number } & TableStep)
  | ({
      phase: "loaded";
      mode: "new table" | "upsert";
      written: number;
      unchanged: number;
    } & TableStep)
  /** Restoring the deferred foreign keys of a table. */
  | ({ phase: "backfilling" } & TableStep)
  /** Refreshing planner statistics of a table that changed. */
  | ({ phase: "analyzing" } & TableStep);

export interface PlanOptions extends SubsetOptions {
  /** Source connection string. */
  source: string;
  seeds: Seed[];
}

/** SubsetOptions with every default filled in. */
export function subsetDefaults(options: SubsetOptions): Required<SubsetOptions> {
  return {
    schema: options.schema ?? emptySchemaFile(),
    traversal: options.traversal ?? "downstream",
    strictCycles: options.strictCycles ?? false,
    onProgress: options.onProgress ?? (() => {}),
  };
}

/** The subset to load, and everything derived from the source needed to load it. */
export interface Subset {
  /** The source database's catalog. */
  catalog: Schema;
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
  options: SubsetOptions = {},
): Promise<Subset> {
  const { schema: file, traversal, strictCycles, onProgress } = subsetDefaults(options);
  onProgress({ phase: "inspecting" });
  const catalog = await inspect(source);
  const graph = buildGraph(catalog, file);
  const closure = await computeClosure(source, graph, seeds, {
    traversal,
    strictCycles,
    cycleBreaks: file.cycleBreaks,
    onProgress: ({ rows, tables }) => onProgress({ phase: "collecting", rows, tables }),
  });
  const deferred = deferredForeignKeys(catalog, graph, closure, file.cycleBreaks);
  const order = tableOrder(catalog, closure.rows.keys(), deferredColumns(deferred));
  return { catalog, graph, closure, order, deferred };
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
  /** Wall-clock time the plan took. */
  durationMs: number;
}

/** Computes the subset without writing anything: per-table row counts in load order. */
export async function plan(options: PlanOptions): Promise<PlanResult> {
  const started = performance.now();
  const source = await connect(options.source);
  try {
    const { graph, closure, order } = await readOnly(source, () =>
      computeSubset(source, options.seeds, options),
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
      durationMs: performance.now() - started,
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
