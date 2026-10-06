import { type ForeignKey, findColumn, type Schema, type Table, tableId } from "./catalog.js";
import { type Closure, valuesKey } from "./closure.js";
import { ident, type Queryable, qualified, type Row } from "./db.js";
import type { Graph, NodeId } from "./graph.js";
import type { TableColumn } from "./model.js";
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
  cycleBreaks: TableColumn[] = [],
): Map<NodeId, ForeignKey[]> {
  const breaks: TableColumn[] = [...cycleBreaks, ...closure.breaks];
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
function keyedValues(
  t: Table,
  keyColumns: string[],
  extraColumns: string[],
  rows: (string | null)[][],
) {
  const types = [...keyColumns, ...extraColumns].map((c) => findColumn(t, c)!.sqlType);
  const params: (string | null)[] = [];
  const tuples = rows.map(
    (r) => `(${r.map((v, i) => `$${params.push(v)}::${types[i]}`).join(", ")})`,
  );
  const aliases = types.map((_, i) => `v${i}`).join(", ");
  return {
    from: `(VALUES ${tuples.join(", ")}) AS v(${aliases})`,
    on: keyColumns.map((c, i) => `t.${ident(c)} = v.v${i}`).join(" AND "),
    params,
  };
}

/**
 * Merges rows staged in `staging` (same columns as `t`) into `t`, keyed on
 * its primary key: new rows are inserted; an existing row is updated only
 * where some column actually differs, so an unchanged row costs no write
 * (no new row version, no WAL for its data). Deferred columns are left to
 * backfill: inserted as staged (NULL) and never overwritten by the merge.
 * Columns are compared as text, the exact form the rows were copied in:
 * that works for types with no `=` (json, point, xml) and catches changes
 * `=` calls equal (numeric 1.0 vs 1.00, citext case).
 * Returns the number of rows inserted or updated.
 */
export async function mergeStaged(
  db: Queryable,
  t: Table,
  staging: string,
  deferred: ReadonlySet<string> = new Set(),
): Promise<number> {
  const columns = t.columns.map((c) => c.name);
  const pk = new Set(t.primaryKey);
  const compared = columns.filter((c) => !pk.has(c) && !deferred.has(c));
  const list = columns.map(ident).join(", ");
  const target = qualified(tableId(t));
  const onConflict = compared.length
    ? `DO UPDATE SET ${compared.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ")}
       WHERE (${compared.map((c) => `${target}.${ident(c)}::text`).join(", ")}) IS DISTINCT FROM (${compared.map((c) => `EXCLUDED.${ident(c)}::text`).join(", ")})`
    : "DO NOTHING";
  const result = await db.query(
    `INSERT INTO ${target} (${list}) SELECT ${list} FROM ${staging}
     ON CONFLICT (${t.primaryKey.map(ident).join(", ")}) ${onConflict}`,
  );
  return result.rowCount ?? 0;
}

export interface BackfillResult {
  /** Rows whose reference was restored (set to a non-NULL value). */
  backfilled: number;
  /** Rows whose referenced row is outside the subset, so the column stays NULL. */
  leftNull: number;
}

/**
 * Sets each deferred FK on the subset's rows to its source value where the
 * referenced row is in the subset, and to NULL where it isn't (the
 * documented behavior at a subset boundary). Every row is covered, not
 * only the ones loaded NULL: the merge never touches deferred columns, so
 * this is what brings a re-synced row's reference up to date. Only rows
 * whose value differs are written.
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
      // A reference with a NULL column isn't checked (MATCH SIMPLE): kept as is.
      const outside =
        fk.fromColumns.every((c) => row[c] != null) && !present.has(valuesKey(fk.fromColumns, row));
      if (outside) result.leftNull++;
      restore.push([
        ...t.primaryKey.map((c) => row[c] ?? null),
        ...fk.fromColumns.map((c) => (outside ? null : (row[c] ?? null))),
      ]);
    }
    for (const batch of chunk(restore, t.primaryKey.length + fk.fromColumns.length)) {
      const v = keyedValues(t, t.primaryKey, fk.fromColumns, batch);
      const set = fk.fromColumns
        .map((c, i) => `${ident(c)} = v.v${t.primaryKey.length + i}`)
        .join(", ");
      const values = fk.fromColumns.map((_, i) => `v.v${t.primaryKey.length + i}`).join(", ");
      // Only rows whose value differs are written, so an unchanged re-sync backfills nothing.
      const differs = `(${fk.fromColumns.map((c) => `t.${ident(c)}`).join(", ")}) IS DISTINCT FROM (${values})`;
      // Rows set to NULL are written too, but only restored references count.
      const updated = await db.query(
        `WITH u AS (
           UPDATE ${qualified(tableId(t))} AS t SET ${set} FROM ${v.from} WHERE ${v.on} AND ${differs}
           RETURNING num_nonnulls(${values}) > 0 AS restored
         ) SELECT count(*) FILTER (WHERE restored) AS restored FROM u`,
        v.params,
      );
      result.backfilled += Number(updated.rows[0]?.restored ?? 0);
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
    await db.query(
      `DELETE FROM ${qualified(tableId(t))} AS t USING ${v.from} WHERE ${v.on}`,
      v.params,
    );
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
