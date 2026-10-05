import type { DependencyBreak, Seed, TableColumn, Traversal } from "./config.js";
import { ident, type Queryable, qualified, querySingleStatement, type Row } from "./db.js";
import type { Edge, FixedEdge, Graph, NodeId, PolymorphicReverse } from "./graph.js";

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

export interface ClosureOptions {
  traversal?: Traversal;
  strictCycles?: boolean;
  dependencyBreaks?: DependencyBreak[];
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
  const queue: Found[] = [];
  for (const seed of seeds) {
    if (!graph.table(seed.table)) throw new Error(`no such table "${seed.table}" in source schema`);
    requirePrimaryKey(graph, seed.table);
    const seedRows = await querySingleStatement(
      db,
      `SELECT * FROM ${qualified(seed.table)} WHERE (${seed.where})`,
    );
    for (const row of seedRows.rows) {
      const found: Found = { table: seed.table, row, reach: "downstream" };
      if (walker.discover(found)) queue.push(found);
    }
  }

  // Breadth-first; every row arrives with its full data already fetched.
  for (let i = 0; i < queue.length; i++) {
    for (const next of await walker.expand(queue[i]!)) {
      if (walker.discover(next)) queue.push(next);
    }
  }
  return walker.closure;
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
   * Records a found row; true if it should be (re)expanded: the first
   * time it's seen, or when a row seen only as a parent is now reached
   * downstream, since its children weren't walked the first time.
   */
  discover(found: Found): boolean {
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
      return true;
    }
    return false;
  }

  async expand({ table, row, reach }: Found): Promise<Found[]> {
    const next: Found[] = [];

    for (const e of this.graph.outgoing(table)) {
      const values = valuesOf(row, e.fromColumns);
      if (!values) continue; // nullable reference not set: no parent
      if (e.kind === "polymorphic") {
        for (const r of await this.followPolymorphic(row, e, values)) next.push(r);
        continue;
      }
      if (this.graph.inCycle(e) && this.breakEdge(e)) continue;
      const rows = await this.select(e.to, e.toColumns, values);
      for (const r of rows) next.push({ table: e.to, row: r, reach: this.parentReach });
    }

    if (this.options.traversal === "full" || reach === "downstream") {
      for (const e of this.graph.incoming(table)) {
        const values = valuesOf(row, e.toColumns);
        if (!values) continue;
        for (const r of await this.select(e.from, e.fromColumns, values)) {
          next.push({ table: e.from, row: r, reach: "downstream" });
        }
      }
      for (const pr of this.graph.polymorphicIncoming(table)) {
        for (const r of await this.followPolymorphicReverse(row, pr)) {
          next.push({ table: pr.edge.from, row: r, reach: "downstream" });
        }
      }
    }
    return next;
  }

  private async followPolymorphic(
    row: Row,
    e: Extract<Edge, { kind: "polymorphic" }>,
    values: string[],
  ) {
    const typeValue = row[e.typeColumn];
    if (typeValue == null) return [];
    const target = e.targets[typeValue];
    if (!target) {
      this.closure.warnings.push(
        `${e.from}.${e.typeColumn}: unrecognized polymorphic type value "${typeValue}", no matching target in config; skipped`,
      );
      return [];
    }
    const rows = await this.select(target.to, target.toColumns, values);
    return rows.map((r): Found => ({ table: target.to, row: r, reach: this.parentReach }));
  }

  private async followPolymorphicReverse(row: Row, { edge, typeValue }: PolymorphicReverse) {
    const target = edge.targets[typeValue]!;
    const values = valuesOf(row, target.toColumns);
    if (!values) return [];
    return this.select(edge.from, [...edge.fromColumns, edge.typeColumn], [...values, typeValue]);
  }

  /**
   * Decides whether a cyclic edge stops being followed. Once broken, an
   * edge stays broken for the whole walk: the point is to stop an
   * unbounded chain (climbing a management hierarchy), not to allow one
   * hop per row.
   */
  private breakEdge(e: FixedEdge): boolean {
    if (e.fromColumns.some((c) => this.broken.has(columnId(e.from, c)))) return true;

    const breaks = this.options.dependencyBreaks ?? [];
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

  private async select(table: NodeId, columns: string[], values: string[]): Promise<Row[]> {
    const where = columns.map((c, i) => `${ident(c)} = $${i + 1}`).join(" AND ");
    const result = await this.db.query(`SELECT * FROM ${qualified(table)} WHERE ${where}`, values);
    return result.rows;
  }
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
