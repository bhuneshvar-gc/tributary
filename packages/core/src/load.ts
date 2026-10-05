import {
  type ForeignKey,
  type Schema,
  type Table,
  tableId,
} from "./catalog.js";
import type { AppliedBreak, Closure } from "./closure.js";
import type { DependencyBreak } from "./config.js";
import { ident, type Queryable, qualified, type Row } from "./db.js";
import type { Graph, NodeId } from "./graph.js";
import type { DeferredColumns } from "./order.js";

/**
 * Real FK constraints whose columns are loaded NULL and backfilled once
 * every table is in, because no row-by-row insert order can satisfy
 * them: self-references, edges a dependency break or the closure walk
 * broke, and constraints an `ignore` relation hid from the walk (whose
 * parents may not be in the subset at all).
 */
export function deferredForeignKeys(
  schema: Schema,
  graph: Graph,
  closure: Pick<Closure, "rows" | "breaks">,
  dependencyBreaks: DependencyBreak[] = [],
): Map<NodeId, ForeignKey[]> {
  const breaks: Pick<AppliedBreak, "table" | "column">[] = [
    ...dependencyBreaks,
    ...closure.breaks,
  ];
  const ignored = new Set(
    graph.ignored.map((e) => `${e.from}\0${e.constraintName}`),
  );
  const deferred = new Map<NodeId, ForeignKey[]>();

  for (const t of schema.tables) {
    const id = tableId(t);
    if (!closure.rows.has(id)) continue;
    const fks = t.foreignKeys.filter(
      (fk) =>
        fk.toTable === id ||
        ignored.has(`${id}\0${fk.constraintName}`) ||
        breaks.some((b) => b.table === id && fk.fromColumns.includes(b.column)),
    );
    if (fks.length) deferred.set(id, fks);
  }
  return deferred;
}

export function deferredColumns(
  fks: Map<NodeId, ForeignKey[]>,
): DeferredColumns {
  return new Map(
    [...fks].map(([id, list]) => [
      id,
      new Set(list.flatMap((fk) => fk.fromColumns)),
    ]),
  );
}

/** A deferred NOT NULL column can't be loaded NULL first: a named preflight error. */
export function checkDeferrable(
  schema: Schema,
  fks: Map<NodeId, ForeignKey[]>,
): void {
  for (const t of schema.tables) {
    for (const fk of fks.get(tableId(t)) ?? []) {
      const column = fk.fromColumns.find(
        (c) => !t.columns.find((col) => col.name === c)?.nullable,
      );
      if (column) {
        throw new Error(
          `${tableId(t)}.${column} (constraint ${fk.constraintName}) is NOT NULL but has to be loaded NULL and backfilled, because it's a self-reference or a broken cycle; tributary can't load it`,
        );
      }
    }
  }
}

const MAX_PARAMS = 60_000;
const MAX_ROWS = 1_000;

function chunk<T>(items: T[], width: number): T[][] {
  const size = Math.max(
    1,
    Math.min(MAX_ROWS, Math.floor(MAX_PARAMS / Math.max(1, width))),
  );
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** A `VALUES (...)` list with typed parameters, for joining against a table. */
function typedValues(
  rows: (string | null)[][],
  types: string[],
): { sql: string; params: (string | null)[] } {
  const params: (string | null)[] = [];
  const tuples = rows.map(
    (r) => `(${r.map((v, i) => `$${params.push(v)}::${types[i]}`).join(", ")})`,
  );
  return { sql: `VALUES ${tuples.join(", ")}`, params };
}

function columnTypes(t: Table, names: string[]): string[] {
  return names.map((n) => t.columns.find((c) => c.name === n)!.sqlType);
}

/**
 * Upserts rows into `table` keyed on its primary key: an existing target
 * row is updated to match the source, a new one inserted. Values travel as
 * Postgres text and are parsed by the target's input functions. Deferred
 * columns are written NULL (on insert and update alike) for backfill.
 */
export async function upsertRows(
  db: Queryable,
  t: Table,
  rows: Row[],
  deferred: ReadonlySet<string> = new Set(),
): Promise<number> {
  const columns = t.columns.map((c) => c.name);
  const pk = new Set(t.primaryKey);
  const updates = columns
    .filter((c) => !pk.has(c))
    .map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`);
  const onConflict = updates.length
    ? `DO UPDATE SET ${updates.join(", ")}`
    : "DO NOTHING";
  let upserted = 0;
  for (const batch of chunk(rows, columns.length)) {
    const params: (string | null)[] = [];
    const tuples = batch.map(
      (row) =>
        `(${columns.map((c) => `$${params.push(deferred.has(c) ? null : (row[c] ?? null))}`).join(", ")})`,
    );
    const result = await db.query(
      `INSERT INTO ${qualified(tableId(t))} (${columns.map(ident).join(", ")}) VALUES ${tuples.join(", ")}
       ON CONFLICT (${t.primaryKey.map(ident).join(", ")}) ${onConflict}`,
      params,
    );
    upserted += result.rowCount ?? 0;
  }
  return upserted;
}

export interface BackfillResult {
  backfilled: number;
  /** Rows whose referenced row is outside the subset, so the column stays NULL. */
  leftNull: number;
}

/**
 * Restores deferred FK values, but only where the referenced row is in
 * the subset; the rest stay NULL, the documented behavior at a subset
 * boundary.
 */
export async function backfill(
  db: Queryable,
  t: Table,
  fks: ForeignKey[],
  closure: Pick<Closure, "rows">,
): Promise<BackfillResult> {
  const result: BackfillResult = { backfilled: 0, leftNull: 0 };
  const rows = [...(closure.rows.get(tableId(t))?.values() ?? [])];
  for (const fk of fks) {
    const present = new Set(
      [...(closure.rows.get(fk.toTable)?.values() ?? [])].map((p) =>
        JSON.stringify(fk.toColumns.map((c) => p[c])),
      ),
    );
    const restore: (string | null)[][] = [];
    for (const row of rows) {
      const values = fk.fromColumns.map((c) => row[c] ?? null);
      if (values.some((v) => v === null)) continue;
      if (present.has(JSON.stringify(values)))
        restore.push([...t.primaryKey.map((c) => row[c] ?? null), ...values]);
      else result.leftNull++;
    }
    const names = [...t.primaryKey, ...fk.fromColumns];
    const types = columnTypes(t, names);
    const alias = names.map((_, i) => `v${i}`);
    for (const batch of chunk(restore, names.length)) {
      const { sql, params } = typedValues(batch, types);
      const set = fk.fromColumns
        .map((c, i) => `${ident(c)} = v.v${t.primaryKey.length + i}`)
        .join(", ");
      const where = t.primaryKey
        .map((c, i) => `t.${ident(c)} = v.v${i}`)
        .join(" AND ");
      const updated = await db.query(
        `UPDATE ${qualified(tableId(t))} AS t SET ${set} FROM (${sql}) AS v(${alias.join(", ")}) WHERE ${where}`,
        params,
      );
      result.backfilled += updated.rowCount ?? 0;
    }
  }
  return result;
}

/** Deletes exactly the subset's rows (by primary key) from the target table, never more. */
export async function deleteRows(
  db: Queryable,
  t: Table,
  rows: Row[],
): Promise<number> {
  const types = columnTypes(t, t.primaryKey);
  const alias = t.primaryKey.map((_, i) => `v${i}`);
  let deleted = 0;
  for (const batch of chunk(rows, t.primaryKey.length)) {
    const { sql, params } = typedValues(
      batch.map((r) => t.primaryKey.map((c) => r[c] ?? null)),
      types,
    );
    const where = t.primaryKey
      .map((c, i) => `t.${ident(c)} = v.v${i}`)
      .join(" AND ");
    const result = await db.query(
      `DELETE FROM ${qualified(tableId(t))} AS t USING (${sql}) AS v(${alias.join(", ")}) WHERE ${where}`,
      params,
    );
    deleted += result.rowCount ?? 0;
  }
  return deleted;
}

/** Turns an opaque constraint error into one naming the table, constraint and likely cause. */
export function explainLoadError(error: unknown, table: NodeId): unknown {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e?.code === "23503") {
    return new Error(
      `foreign key violation loading ${table} (constraint ${e.constraint}): the referenced row isn't in this subset or on the target, likely a dangling reference in the source data: ${e.message}`,
      { cause: error },
    );
  }
  if (e?.code === "23505") {
    return new Error(
      `unique violation loading ${table} (constraint ${e.constraint}): a target row conflicts on a unique key other than the primary key: ${e.message}`,
      { cause: error },
    );
  }
  return error;
}
