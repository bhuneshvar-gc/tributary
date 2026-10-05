import { findColumn, type Schema, type Table, tableId } from "./catalog.js";
import { type ColumnRef, formatRef, type Relation, SchemaFileError, tableKey } from "./model.js";
import type { SchemaFile } from "./schema-file.js";

/** A schema-qualified table identifier: "schema.table". */
export type NodeId = string;

/** A reference with a fixed target table. Columns pair by index. */
export interface FixedEdge {
  kind: "fixed";
  /** "catalog": a real FK constraint. "declared": a schema file relation. */
  source: "catalog" | "declared";
  from: NodeId;
  fromColumns: string[];
  to: NodeId;
  toColumns: string[];
  constraintName?: string;
}

/**
 * A declared polymorphic association: which table a row points at depends
 * on the runtime value of its `typeColumn`.
 */
export interface PolymorphicEdge {
  kind: "polymorphic";
  source: "declared";
  from: NodeId;
  fromColumns: string[];
  typeColumn: string;
  targets: Record<string, { to: NodeId; toColumns: string[] }>;
}

export type Edge = FixedEdge | PolymorphicEdge;

/** A polymorphic edge seen from one of its targets. */
export interface PolymorphicReverse {
  edge: PolymorphicEdge;
  typeValue: string;
}

export function edgeTargets(e: Edge): NodeId[] {
  return e.kind === "fixed" ? [e.to] : Object.values(e.targets).map((t) => t.to);
}

/**
 * The merged FK graph: tables from a catalog Schema, edges from real
 * constraints plus the schema file's declared relations (minus
 * ignores). Both directions are indexed so the closure walk can find a
 * row's parents and children by lookup.
 */
export class Graph {
  readonly tables = new Map<NodeId, Table>();
  private readonly out = new Map<NodeId, Edge[]>();
  private readonly in = new Map<NodeId, FixedEdge[]>();
  private readonly polyIn = new Map<NodeId, PolymorphicReverse[]>();
  /** Catalog FKs suppressed by an `ignore` relation (still real constraints on target). */
  readonly ignored: FixedEdge[] = [];

  table(id: NodeId): Table | undefined {
    return this.tables.get(id);
  }

  /** Edges from `id` to the tables it references (its parents). */
  outgoing(id: NodeId): Edge[] {
    return this.out.get(id) ?? [];
  }

  /** Fixed edges pointing at `id` (its children). */
  incoming(id: NodeId): FixedEdge[] {
    return this.in.get(id) ?? [];
  }

  /** Polymorphic edges with `id` as one of their targets. */
  polymorphicIncoming(id: NodeId): PolymorphicReverse[] {
    return this.polyIn.get(id) ?? [];
  }

  /**
   * Whether following `e` can lead back to its own table: a self-reference,
   * or both ends in the same strongly connected component.
   */
  inCycle(e: Edge): boolean {
    const component = this.component.get(e.from);
    return edgeTargets(e).some(
      (to) => to === e.from || (component !== undefined && this.component.get(to) === component),
    );
  }

  /** Whether two distinct tables are part of the same multi-table cycle. */
  sameCycle(a: NodeId, b: NodeId): boolean {
    const component = this.component.get(a);
    return component !== undefined && this.component.get(b) === component;
  }

  private component = new Map<NodeId, number>();

  /** @internal Recomputes strongly connected components (Tarjan). */
  indexCycles(): void {
    const index = new Map<NodeId, number>();
    const low = new Map<NodeId, number>();
    const onStack = new Set<NodeId>();
    const stack: NodeId[] = [];
    let next = 0;
    let componentId = 0;
    this.component = new Map();

    const visit = (v: NodeId) => {
      index.set(v, next);
      low.set(v, next);
      next++;
      stack.push(v);
      onStack.add(v);
      for (const e of this.outgoing(v)) {
        for (const w of edgeTargets(e)) {
          if (!index.has(w)) {
            visit(w);
            low.set(v, Math.min(low.get(v)!, low.get(w)!));
          } else if (onStack.has(w)) {
            low.set(v, Math.min(low.get(v)!, index.get(w)!));
          }
        }
      }
      if (low.get(v) === index.get(v)) {
        const members: NodeId[] = [];
        let w: NodeId;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
        } while (w !== v);
        // Singleton components only form a cycle via a self-loop, which
        // inCycle checks directly, so they get no shared id.
        if (members.length > 1) {
          for (const m of members) this.component.set(m, componentId);
          componentId++;
        }
      }
    };
    for (const id of this.tables.keys()) if (!index.has(id)) visit(id);
  }

  /** @internal */
  addEdge(e: Edge): void {
    push(this.out, e.from, e);
    if (e.kind === "fixed") push(this.in, e.to, e);
    else
      for (const [typeValue, t] of Object.entries(e.targets))
        push(this.polyIn, t.to, { edge: e, typeValue });
  }

  /** @internal */
  removeEdge(e: FixedEdge): void {
    this.out.set(
      e.from,
      this.outgoing(e.from).filter((o) => o !== e),
    );
    this.in.set(
      e.to,
      this.incoming(e.to).filter((o) => o !== e),
    );
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * Merges a catalog schema with a schema file's relations into a Graph.
 * Every relation is checked against the catalog; all unknown table/column
 * references are reported together in one SchemaFileError, each named by where
 * the schema file declared it.
 */
export function buildGraph(
  schema: Schema,
  file?: Pick<SchemaFile, "relations" | "cycleBreaks">,
): Graph {
  const { graph, issues } = mergeSchemaFile(schema, file);
  if (issues.length) throw new SchemaFileError(issues);
  return graph;
}

/**
 * Every way `file` doesn't fit the database `schema`: relations naming
 * missing tables or columns, cycle breaks that don't break a cycle, and
 * tables the file lists (even with nothing declared) that don't exist.
 * Empty when the file fits. buildGraph tolerates the last kind, so a
 * table dropped from the database doesn't block syncs.
 */
export function checkSchemaFile(schema: Schema, file: SchemaFile): string[] {
  const known = new Set(schema.tables.map(tableId));
  const missing = file.tables
    .filter((t) => !known.has(t.table))
    .map((t) => `${t.at}: no such table "${t.table}" in the database`);
  return [...missing, ...mergeSchemaFile(schema, file).issues];
}

function mergeSchemaFile(
  schema: Schema,
  file: Pick<SchemaFile, "relations" | "cycleBreaks"> | undefined,
): { graph: Graph; issues: string[] } {
  const g = new Graph();
  for (const t of schema.tables) g.tables.set(tableId(t), t);
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      g.addEdge({
        kind: "fixed",
        source: "catalog",
        from: fk.fromTable,
        fromColumns: fk.fromColumns,
        to: fk.toTable,
        toColumns: fk.toColumns,
        constraintName: fk.constraintName,
      });
    }
  }

  // `at` is set by parseSchemaFile; relations built in code fall back to their index.
  const issues: string[] = [];
  file?.relations.forEach((r, i) => {
    const problem = mergeRelation(g, r);
    if (problem) issues.push(`${r.at ?? `relations.${i}`}: ${problem}`);
  });
  if (issues.length) return { graph: g, issues };

  g.indexCycles();
  file?.cycleBreaks.forEach((b, i) => {
    const at = b.at ?? `cycleBreaks.${i}`;
    const table = g.table(b.table);
    if (!table) issues.push(`${at}: no such table "${b.table}" in source schema`);
    else if (!findColumn(table, b.column))
      issues.push(`${at}: no such column "${b.column}" on "${b.table}"`);
    else if (!g.outgoing(b.table).some((e) => e.fromColumns.includes(b.column) && g.inCycle(e))) {
      issues.push(
        `${at}: ${b.table}.${b.column} is not part of any foreign key cycle; remove it or fix the table/column`,
      );
    }
  });
  return { graph: g, issues };
}

/** Returns a description of what's wrong, or undefined once merged. */
function mergeRelation(g: Graph, r: Relation): string | undefined {
  switch (r.kind) {
    case "foreignKey": {
      const problem = checkRef(g, "from", r.from) ?? checkRef(g, "to", r.to);
      if (problem) return problem;
      g.addEdge({
        kind: "fixed",
        source: "declared",
        from: tableKey(r.from),
        fromColumns: r.from.columns,
        to: tableKey(r.to),
        toColumns: r.to.columns,
      });
      return;
    }
    case "polymorphic": {
      const problem =
        checkRef(g, "from", r.from) ??
        checkRef(g, "polymorphicType", r.typeColumn) ??
        Object.entries(r.targets)
          .map(([value, t]) => checkRef(g, `targets["${value}"]`, t))
          .find(Boolean);
      if (problem) return problem;
      g.addEdge({
        kind: "polymorphic",
        source: "declared",
        from: tableKey(r.from),
        fromColumns: r.from.columns,
        typeColumn: r.typeColumn.columns[0]!,
        targets: Object.fromEntries(
          Object.entries(r.targets).map(([v, t]) => [v, { to: tableKey(t), toColumns: t.columns }]),
        ),
      });
      return;
    }
    case "ignore": {
      const id = tableKey(r.column);
      const column = r.column.columns[0]!;
      const label = `ignore=${formatRef(r.column)}`;
      if (!g.table(id)) return `${label}: no such table "${id}" in source schema`;
      const matches = g
        .outgoing(id)
        .filter(
          (e): e is FixedEdge =>
            e.kind === "fixed" && e.source === "catalog" && e.fromColumns.includes(column),
        );
      if (matches.length === 0)
        return `${label}: no catalog foreign key on "${id}" uses column "${column}"`;
      if (matches.length > 1) {
        return `${label}: ambiguous, ${matches.length} foreign key constraints on "${id}" use column "${column}"`;
      }
      g.removeEdge(matches[0]!);
      g.ignored.push(matches[0]!);
      return;
    }
  }
}

function checkRef(g: Graph, field: string, ref: ColumnRef): string | undefined {
  const id = tableKey(ref);
  const t = g.table(id);
  const label = `${field}=${formatRef(ref)}`;
  if (!t) return `${label}: no such table "${id}" in source schema`;
  const missing = ref.columns.find((c) => !findColumn(t, c));
  if (missing) return `${label}: no such column "${missing}" on "${id}"`;
}
