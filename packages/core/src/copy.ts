import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";
import { findColumn, type Table, tableId } from "./catalog.js";
import { ident, literal, qualified, type Row } from "./db.js";

/** Keys per COPY statement: each chunk's key list is written into the SQL. */
export const COPY_CHUNK_KEYS = 50_000;

/**
 * A Postgres array literal of text values, every element quoted so that
 * values like NULL, {braces} or a,b stay plain strings.
 */
function arrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}

/**
 * A WHERE condition matching exactly `keys` on the table's primary key.
 * COPY can't take bind parameters, so the keys are inlined as escaped,
 * typed array literals: `id = ANY('{...}'::bigint[])`, or for a composite
 * key `(a, b) IN (SELECT * FROM unnest('{...}'::ta[], '{...}'::tb[]))`.
 */
export function keyFilter(t: Table, keys: Row[]): string {
  const arrays = t.primaryKey.map((c) => {
    const values = keys.map((k) => {
      const v = k[c];
      if (v == null) throw new Error(`internal error: ${tableId(t)} key column ${c} is NULL`);
      return v;
    });
    return `${literal(arrayLiteral(values))}::${findColumn(t, c)!.sqlType}[]`;
  });
  if (t.primaryKey.length === 1) return `${ident(t.primaryKey[0]!)} = ANY(${arrays[0]})`;
  return `(${t.primaryKey.map(ident).join(", ")}) IN (SELECT * FROM unnest(${arrays.join(", ")}))`;
}

export interface StreamOptions {
  /** Columns sent as NULL. */
  nulled?: ReadonlySet<string>;
  /** Called as rows go through, with the running count. */
  onRows?: (copied: number) => void;
}

/**
 * Streams the source rows of `t` with the given keys straight into `into`
 * on the target (a table or staging table with the same columns), COPY to
 * COPY, without parsing rows in Node. Runs in whatever transactions the
 * two clients are in. Returns the number of rows copied.
 */
export async function streamRows(
  source: pg.Client,
  target: pg.Client,
  t: Table,
  keys: Row[],
  into: string,
  { nulled = new Set(), onRows }: StreamOptions = {},
): Promise<number> {
  const columns = t.columns.map((c) => c.name);
  const select = t.columns
    .map((c) => (nulled.has(c.name) ? `NULL::${c.sqlType} AS ${ident(c.name)}` : ident(c.name)))
    .join(", ");
  let copied = 0;
  for (let i = 0; i < keys.length; i += COPY_CHUNK_KEYS) {
    const chunk = keys.slice(i, i + COPY_CHUNK_KEYS);
    const out = source.query(
      copyTo(
        `COPY (SELECT ${select} FROM ${qualified(tableId(t))} WHERE ${keyFilter(t, chunk)}) TO STDOUT`,
      ),
    );
    const sink = target.query(
      copyFrom(`COPY ${into} (${columns.map(ident).join(", ")}) FROM STDIN`),
    );
    if (onRows) {
      const before = copied;
      await pipeline(
        out,
        countRows((n) => onRows(before + n)),
        sink,
      );
    } else await pipeline(out, sink);
    copied += sink.rowCount ?? 0;
    onRows?.(copied);
  }
  return copied;
}

/**
 * Passes COPY text through, reporting the rows seen so far. Each row ends
 * in a newline, and newlines inside values are escaped, so counting
 * newline bytes counts rows.
 */
function countRows(report: (rows: number) => void): Transform {
  let rows = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) rows++;
      report(rows);
      done(null, chunk);
    },
  });
}
