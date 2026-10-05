import { type ForeignKey, findColumn, type Schema, type Table, tableId } from "./catalog.js";
import { type Closure, valuesKey } from "./closure.js";
import type { TableColumn } from "./config.js";
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
  dependencyBreaks: TableColumn[] = [],
): Map<NodeId, ForeignKey[]> {
  const breaks: TableColumn[] = [...dependencyBreaks, ...closure.breaks];
  const ignored = new Set(graph.ignored.map((e) => `${e.from}\0${e.constraintName}`));
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

export function deferredColumns(fks: Map<NodeId, ForeignKey[]>): DeferredColumns {
  return new Map([...fks].map(([id, list]) => [id, new Set(list.flatMap((fk) => fk.fromColumns))]));
}

/** A deferred NOT NULL column can't be loaded NULL first: a named preflight error. */
export function checkDeferrable(schema: Schema, fks: Map<NodeId, ForeignKey[]>): void {
  for (const t of schema.tables) {
    for (const fk of fks.get(tableId(t)) ?? []) {
      const column = fk.fromColumns.find((c) => !findColumn(t, c)?.nullable);
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

/** Splits rows into batches that stay under Postgres's parameter limit. */
function chunk<T>(items: T[], width: number): T[][] {
  const size = Math.max(1, Math.min(MAX_ROWS, Math.floor(MAX_PARAMS / Math.max(1, width))));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Builds `(VALUES ($1::type, ...), ...) AS v(v0, v1, ...)` with typed
 * parameters, plus the condition joining its first `keyColumns.length`
 * values to `t`'s key columns. Explicit casts are needed here: unlike an
 * INSERT's VALUES, a joined VALUES list has no target column types to infer.
 */
function keyedValues(t: Table, keyColumns: string[], extraColumns: string[], rows: (string | null)[][]) {
  const types = [...keyColumns, ...extraColumns].map((c) => findColumn(t, c)!.sqlType);
  const params: (string | null)[] = [];
  const tuples = rows.map((r) => `(${r.map((v, i) => `$${params.push(v)}::${types[i]}`).join(", ")})`);
  const aliases = types.map((_, i) => `v${i}`).join(", ");
  return {
    from: `(VALUES ${tuples.join(", ")}) AS v(${aliases})`,
    on: keyColumns.map((c, i) => `t.${ident(c)} = v.v${i}`).join(" AND "),
    params,
  };
}

/**
 * Upserts rows into `table` keyed on its primary key: an existing target
 * row is updated to match the source, a new one inserted. Values travel as
 * Postgres text and are parsed by the target's input functions. Deferred
 * columns are written NULL (on insert and update alike) for backfill.
 * Returns the number of rows inserted or updated.
 */
export async function upsertRows(
  db: Queryable,
  t: Table,
  rows: Row[],
  deferred: ReadonlySet<string> = new Set(),
): Promise<number> {
  const columns = t.columns.map((c) => c.name);
  const pk = new Set(t.primaryKey);
  const nonKey = columns.filter((c) => !pk.has(c));
  // A key-only table still does a (no-op) update, so existing rows count as upserted.
  const updated = nonKey.length ? nonKey : t.primaryKey.slice(0, 1);
  const set = updated.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ");
  let upserted = 0;
  for (const batch of chunk(rows, columns.length)) {
    const params: (string | null)[] = [];
    const tuples = batch.map(
      (row) => `(${columns.map((c) => `$${params.push(deferred.has(c) ? null : (row[c] ?? null))}`).join(", ")})`,
    );
    const result = await db.query(
      `INSERT INTO ${qualified(tableId(t))} (${columns.map(ident).join(", ")}) VALUES ${tuples.join(", ")}
       ON CONFLICT (${t.primaryKey.map(ident).join(", ")}) DO UPDATE SET ${set}`,
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
    const parents = closure.rows.get(fk.toTable)?.values() ?? [];
    const present = new Set([...parents].map((p) => valuesKey(fk.toColumns, p)));
    const restore: (string | null)[][] = [];
    for (const row of rows) {
      if (fk.fromColumns.some((c) => row[c] == null)) continue;
      if (!present.has(valuesKey(fk.fromColumns, row))) {
        result.leftNull++;
        continue;
      }
      restore.push([...t.primaryKey, ...fk.fromColumns].map((c) => row[c] ?? null));
    }
    for (const batch of chunk(restore, t.primaryKey.length + fk.fromColumns.length)) {
      const v = keyedValues(t, t.primaryKey, fk.fromColumns, batch);
      const set = fk.fromColumns.map((c, i) => `${ident(c)} = v.v${t.primaryKey.length + i}`).join(", ");
      const updated = await db.query(
        `UPDATE ${qualified(tableId(t))} AS t SET ${set} FROM ${v.from} WHERE ${v.on}`,
        v.params,
      );
      result.backfilled += updated.rowCount ?? 0;
    }
  }
  return result;
}

/** Deletes exactly the subset's rows (by primary key) from the target table, never more. */
export async function deleteRows(db: Queryable, t: Table, rows: Row[]): Promise<void> {
  for (const batch of chunk(rows, t.primaryKey.length)) {
    const v = keyedValues(
      t,
      t.primaryKey,
      [],
      batch.map((r) => t.primaryKey.map((c) => r[c] ?? null)),
    );
    await db.query(`DELETE FROM ${qualified(tableId(t))} AS t USING ${v.from} WHERE ${v.on}`, v.params);
  }
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
