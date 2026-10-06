import { findColumn } from "./catalog.js";
import { ident, type Queryable, qualified, querySingleStatement, type Row } from "./db.js";
import type { Edge, FixedEdge, Graph, NodeId } from "./graph.js";
import type { CycleBreak, Seed, TableColumn, Traversal } from "./model.js";

/**
 * The subset: every row, grouped by table and keyed by primary key, that
 * must travel together to stay referentially valid.
 */
export interface Closure {
  rows: Map<NodeId, Map<string, Row>>;
  /** Cyclic edges the walk stopped following. */
  breaks: AppliedBreak[];
  warnings: string[];
}

/**
 * A cyclic edge the walk stopped following: named by a configured
 * dependency break (auto: false), or picked under best-effort cycle
 * handling (auto: true).
 */
export interface AppliedBreak extends TableColumn {
  auto: boolean;
}

export interface ClosureProgress {
  /** Rows collected so far. */
  rows: number;
  /** Tables with at least one collected row. */
  tables: number;
  /** Breadth-first level just finished (0 = the seeds). */
  level: number;
}

export interface ClosureOptions {
  traversal?: Traversal;
  strictCycles?: boolean;
  cycleBreaks?: CycleBreak[];
  /** Called as rows are collected: after the seeds and after each level. */
  onProgress?: (progress: ClosureProgress) => void;
}

/**
 * Why a row is in the subset. Under "downstream" traversal only
 * downstream rows (the seed, and rows fanned out to from another
 * downstream row) fan out to their children; a row fetched only as a
 * required parent doesn't, unless it's later reached downstream too.
 */
type Reach = "downstream" | "parent";

interface Found {
  table: NodeId;
  row: Row;
  reach: Reach;
}

/** A row's values for `columns`, encoded for use as a map/set key. */
export function valuesKey(columns: string[], row: Row): string {
  return JSON.stringify(columns.map((c) => row[c] ?? null));
}

/** Canonical identity of a row: its primary key values, in key order. */
export function rowKey(primaryKey: string[], row: Row): string {
  return valuesKey(primaryKey, row);
}

/**
 * Computes the referentially-consistent subset rooted at every row each
 * seed's `where` selects in its table. `where` is a raw SQL fragment (an
 * admin tool's trust model: interpolated, not sanitized), sent as exactly
 * one statement; run the walk in a read-only transaction.
 *
 * The walk always follows a row's outgoing edges (its parents, needed
 * for referential validity) and, per the traversal mode, its incoming
 * edges (its children), resolving polymorphic edges through each row's
 * discriminator value. A cyclic outgoing edge is broken (stops being
 * followed) once a row would follow it, per the dependency breaks and
 * strictCycles; the visited set alone terminates incoming traversal.
 */
export async function computeClosure(
  db: Queryable,
  graph: Graph,
  seeds: Seed[],
  options: ClosureOptions = {},
): Promise<Closure> {
  if (seeds.length === 0) throw new Error("no seeds: the subset needs at least one seed");
  const walker = new Walker(db, graph, options);
  let frontier: Found[] = [];
  for (const seed of seeds) {
    if (!graph.table(seed.table)) throw new Error(`no such table "${seed.table}" in source schema`);
    requirePrimaryKey(graph, seed.table);
    const seedRows = await querySingleStatement(
      db,
      `SELECT ${selectList(neededColumns(graph, seed.table))} FROM ${qualified(seed.table)} WHERE (${seed.where})`,
    );
    for (const row of seedRows.rows)
      walker.discover({ table: seed.table, row, reach: "downstream" }, frontier);
  }
  walker.report(0);

  // Breadth-first, a whole level at a time, so each relation costs one
  // query per table per level instead of one per row.
  for (let level = 1; frontier.length > 0; level++) {
    frontier = await walker.expandLevel(frontier);
    walker.report(level);
  }
  return walker.closure;
}

/**
 * The columns the walk and the later load need from a table's rows: its
 * primary key, the columns of every relation it takes part in (either
 * direction, polymorphic discriminators included), and all its real
 * foreign key columns (the load backfills deferred ones from these). The
 * rest of each row stays in the database until it's streamed by COPY, so
 * the closure stays small however wide or numerous the rows are.
 */
export function neededColumns(graph: Graph, table: NodeId): string[] {
  const t = graph.table(table);
  if (!t) return [];
  const needed = new Set(t.primaryKey);
  for (const e of graph.outgoing(table)) {
    for (const c of e.fromColumns) needed.add(c);
    if (e.kind === "polymorphic") needed.add(e.typeColumn);
  }
  for (const e of graph.incoming(table)) for (const c of e.toColumns) needed.add(c);
  for (const { edge, typeValue } of graph.polymorphicIncoming(table)) {
    for (const c of edge.targets[typeValue]!.toColumns) needed.add(c);
  }
  for (const fk of t.foreignKeys) for (const c of fk.fromColumns) needed.add(c);
  // Columns every real FK onto this table references, including ones an
  // `ignore` relation hid from the walk: backfill matches against them.
  for (const other of graph.tables.values()) {
    for (const fk of other.foreignKeys) {
      if (fk.toTable === table) for (const c of fk.toColumns) needed.add(c);
    }
  }
  // In the table's own column order, for stable output.
  return t.columns.map((c) => c.name).filter((c) => needed.has(c));
}

function selectList(columns: string[]): string {
  return columns.map(ident).join(", ");
}

function requirePrimaryKey(graph: Graph, table: NodeId): string[] {
  const pk = graph.table(table)?.primaryKey ?? [];
  if (pk.length === 0) {
    throw new Error(`table "${table}" has no primary key; tributary needs one to identify rows`);
  }
  return pk;
}

class Walker {
  readonly closure: Closure = { rows: new Map(), breaks: [], warnings: [] };
  private readonly reach = new Map<string, Reach>();
  private readonly needed = new Map<NodeId, string[]>();

  columnsOf(table: NodeId): string[] {
    let columns = this.needed.get(table);
    if (!columns) {
      columns = neededColumns(this.graph, table);
      this.needed.set(table, columns);
    }
    return columns;
  }

  /** Broken edges, by columnId of each of their from-columns. */
  private readonly broken = new Set<string>();

  constructor(
    private readonly db: Queryable,
    private readonly graph: Graph,
    private readonly options: ClosureOptions,
  ) {}

  /**
   * How a row reached only as a required parent counts: under "full"
   * traversal every row fans out, so parents are downstream too.
   */
  private get parentReach(): Reach {
    return this.options.traversal === "full" ? "downstream" : "parent";
  }

  /**
   * Records a found row, queueing it on `next` if it should be
   * (re)expanded: the first time it's seen, or when a row seen only as a
   * parent is now reached downstream, since its children weren't walked
   * the first time.
   */
  discover(found: Found, next: Found[]): void {
    const key = rowKey(requirePrimaryKey(this.graph, found.table), found.row);
    const id = `${found.table}\0${key}`;
    const previous = this.reach.get(id);
    if (previous === undefined || (previous === "parent" && found.reach === "downstream")) {
      this.reach.set(id, found.reach);
      let rows = this.closure.rows.get(found.table);
      if (!rows) {
        rows = new Map();
        this.closure.rows.set(found.table, rows);
      }
      rows.set(key, found.row);
      next.push(found);
    }
  }

  report(level: number): void {
    if (!this.options.onProgress) return;
    let rows = 0;
    for (const t of this.closure.rows.values()) rows += t.size;
    this.options.onProgress({ rows, tables: this.closure.rows.size, level });
  }

  /** Expands every row of one level; returns the next level. */
  async expandLevel(frontier: Found[]): Promise<Found[]> {
    const next: Found[] = [];
    const byTable = new Map<NodeId, Found[]>();
    for (const f of frontier) {
      const list = byTable.get(f.table);
      if (list) list.push(f);
      else byTable.set(f.table, [f]);
    }
    for (const [table, found] of byTable) {
      const rows = found.map((f) => f.row);
      await this.followParents(table, rows, next);
      const fanOut =
        this.options.traversal === "full"
          ? rows
          : found.filter((f) => f.reach === "downstream").map((f) => f.row);
      if (fanOut.length) await this.followChildren(table, fanOut, next);
    }
    return next;
  }

  /** Outgoing edges: the rows each row references, needed for referential validity. */
  private async followParents(table: NodeId, rows: Row[], next: Found[]): Promise<void> {
    for (const e of this.graph.outgoing(table)) {
      if (e.kind === "polymorphic") {
        await this.followPolymorphic(e, rows, next);
        continue;
      }
      const tuples = tuplesOf(rows, e.fromColumns);
      if (tuples.length === 0) continue; // nullable references not set: no parents
      if (this.graph.inCycle(e) && this.breakEdge(e)) continue;
      await this.fetchParents(e.to, e.toColumns, tuples, next);
    }
  }

  /** Incoming edges: the rows that reference these rows, fanning the subset out. */
  private async followChildren(table: NodeId, rows: Row[], next: Found[]): Promise<void> {
    for (const e of this.graph.incoming(table)) {
      const tuples = tuplesOf(rows, e.toColumns);
      if (!tuples.length) continue;
      for (const r of await this.selectMany(e.from, e.fromColumns, tuples)) {
        this.discover({ table: e.from, row: r, reach: "downstream" }, next);
      }
    }
    for (const { edge, typeValue } of this.graph.polymorphicIncoming(table)) {
      const tuples = tuplesOf(rows, edge.targets[typeValue]!.toColumns);
      if (!tuples.length) continue;
      const filter = { column: edge.typeColumn, value: typeValue };
      for (const r of await this.selectMany(edge.from, edge.fromColumns, tuples, filter)) {
        this.discover({ table: edge.from, row: r, reach: "downstream" }, next);
      }
    }
  }

  private async followPolymorphic(
    e: Extract<Edge, { kind: "polymorphic" }>,
    rows: Row[],
    next: Found[],
  ): Promise<void> {
    const byType = new Map<string, Row[]>();
    for (const row of rows) {
      const typeValue = row[e.typeColumn];
      if (typeValue == null || !valuesOf(row, e.fromColumns)) continue;
      const list = byType.get(typeValue);
      if (list) list.push(row);
      else byType.set(typeValue, [row]);
    }
    for (const [typeValue, typed] of byType) {
      const target = e.targets[typeValue];
      if (!target) {
        this.closure.warnings.push(
          `${e.from}.${e.typeColumn}: unrecognized polymorphic type value "${typeValue}", no matching target in the schema file; skipped`,
        );
        continue;
      }
      await this.fetchParents(target.to, target.toColumns, tuplesOf(typed, e.fromColumns), next);
    }
  }

  /**
   * Fetches the parent rows `tuples` point at, skipping ones already
   * collected: when the referenced columns are the parent's primary key,
   * the subset can be checked without asking the database.
   */
  private async fetchParents(table: NodeId, columns: string[], tuples: string[][], next: Found[]) {
    const pk = requirePrimaryKey(this.graph, table);
    const collected = this.closure.rows.get(table);
    let wanted = tuples;
    if (collected && pk.length === columns.length && pk.every((c) => columns.includes(c))) {
      const order = pk.map((c) => columns.indexOf(c));
      wanted = tuples.filter((t) => !collected.has(JSON.stringify(order.map((i) => t[i]))));
    }
    if (!wanted.length) return;
    for (const r of await this.selectMany(table, columns, wanted)) {
      this.discover({ table, row: r, reach: this.parentReach }, next);
    }
  }

  /**
   * Decides whether a cyclic edge stops being followed. Once broken, an
   * edge stays broken for the whole walk: the point is to stop an
   * unbounded chain (climbing a management hierarchy), not to allow one
   * hop per row.
   */
  private breakEdge(e: FixedEdge): boolean {
    if (e.fromColumns.some((c) => this.broken.has(columnId(e.from, c)))) return true;

    const breaks = this.options.cycleBreaks ?? [];
    const configured = e.fromColumns.find((c) =>
      breaks.some((b) => b.table === e.from && b.column === c),
    );
    // A multi-table cycle already cut by a configured break elsewhere
    // needs no second break here: the visited set terminates the walk.
    if (
      !configured &&
      e.to !== e.from &&
      breaks.some((b) => this.graph.sameCycle(b.table, e.from))
    ) {
      return false;
    }
    if (!configured && this.options.strictCycles) {
      throw new Error(
        `unresolved cycle: ${e.from}.${e.fromColumns.join(",")} is part of a foreign key cycle with no dependency break (add one, or turn off strictCycles for best-effort)`,
      );
    }
    for (const c of e.fromColumns) this.broken.add(columnId(e.from, c));
    this.closure.breaks.push({
      table: e.from,
      column: configured ?? e.fromColumns[0]!,
      auto: !configured,
    });
    return true;
  }

  /**
   * Rows of `table` whose `columns` match any of `tuples`, in batches:
   * `col = ANY($1::type[])` for one column, `(a, b) IN (SELECT *
   * FROM unnest($1::ta[], $2::tb[]))` for several. Arrays are typed with
   * each column's own type, since the values are Postgres text.
   */
  private async selectMany(
    table: NodeId,
    columns: string[],
    tuples: string[][],
    filter?: { column: string; value: string },
  ): Promise<Row[]> {
    const t = this.graph.table(table)!;
    const types = columns.map((c) => findColumn(t, c)?.sqlType ?? "text");
    const rows: Row[] = [];
    for (let i = 0; i < tuples.length; i += BATCH) {
      const batch = tuples.slice(i, i + BATCH);
      const params: unknown[] = columns.map((_, c) => batch.map((tuple) => tuple[c]));
      const match =
        columns.length === 1
          ? `${ident(columns[0]!)} = ANY($1::${types[0]}[])`
          : `(${columns.map(ident).join(", ")}) IN (SELECT * FROM unnest(${types.map((type, c) => `$${c + 1}::${type}[]`).join(", ")}))`;
      let where = match;
      if (filter) {
        params.push(filter.value);
        where += ` AND ${ident(filter.column)} = $${params.length}`;
      }
      const result = await this.db.query(
        `SELECT ${selectList(this.columnsOf(table))} FROM ${qualified(table)} WHERE ${where}`,
        params,
      );
      for (const row of result.rows) rows.push(row); // can be far too many to spread as arguments
    }
    return rows;
  }
}

/** Keys per query: large enough to cut round trips, small enough for one statement. */
const BATCH = 1_000;

/** The distinct non-NULL values of `columns` across `rows`. */
function tuplesOf(rows: Row[], columns: string[]): string[][] {
  const seen = new Map<string, string[]>();
  for (const row of rows) {
    const values = valuesOf(row, columns);
    if (values) seen.set(JSON.stringify(values), values);
  }
  return [...seen.values()];
}

function columnId(table: NodeId, column: string): string {
  return `${table}.${column}`;
}

/** The row's values for `columns`, or undefined if any is NULL. */
function valuesOf(row: Row, columns: string[]): string[] | undefined {
  const values: string[] = [];
  for (const c of columns) {
    const v = row[c];
    if (v == null) return undefined;
    values.push(v);
  }
  return values;
}
