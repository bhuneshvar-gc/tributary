import pg from "pg";
import format from "pg-format";

/** A row as Postgres's text output: exact values, no JS type coercion. */
export type Row = Record<string, string | null>;

export interface QueryConfig {
  text: string;
  values?: unknown[];
  /** "extended" forces the extended protocol, which allows one statement only. */
  queryMode?: "extended";
}

/** The part of a pg Client the engine needs. */
export interface Queryable {
  query(
    text: string | QueryConfig,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * Runs SQL containing a caller-supplied fragment (a seed predicate) as
 * exactly one statement. Without parameters pg uses the simple protocol,
 * which runs every `;`-separated statement, so a fragment like
 * `true); COMMIT; DELETE ...` could end a read-only transaction and write.
 */
export function querySingleStatement(db: Queryable, text: string) {
  return db.query({ text, values: [], queryMode: "extended" });
}

const rawText = { getTypeParser: () => (value: string) => value };

/**
 * Opens a client that returns every value as Postgres's own text
 * representation. Values are copied between databases as that text and
 * re-parsed by the target's input functions, so timestamps keep their
 * microseconds, bigints and numerics their precision, and so on.
 */
export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    types: rawText as pg.CustomTypesConfig,
  });
  // pg emits connection-level failures (a dropped connection, a protocol
  // error) as 'error' events, which crash the process when unhandled. The
  // in-flight query rejects as well, so that's where they're reported.
  client.on("error", () => {});
  await client.connect();
  return client;
}

/**
 * Runs `fn` inside a transaction, committing if it succeeds. A failed
 * ROLLBACK never hides the error that caused it.
 */
export async function transaction<T>(
  db: Queryable,
  fn: () => Promise<T>,
  begin = "BEGIN",
): Promise<T> {
  await db.query(begin);
  try {
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/**
 * Runs `fn` in a READ ONLY, REPEATABLE READ transaction: one consistent
 * snapshot across every query, and nothing can write. Every query against
 * a source database goes through this.
 */
export function readOnly<T>(db: Queryable, fn: () => Promise<T>): Promise<T> {
  return transaction(db, fn, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
}

/** Runs `fn` with `source` as a client: an existing one, or a fresh connection closed afterwards. */
export async function withClient<T>(
  source: string | Queryable,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  if (typeof source !== "string") return fn(source);
  const client = await connect(source);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function ident(name: string): string {
  return format.ident(name);
}

/** Quotes a "schema.name" id (a table or type) as a qualified identifier. */
export function qualified(id: string): string {
  const { schema, name } = splitQualified(id);
  return `${ident(schema)}.${ident(name)}`;
}

/** Splits "schema.name" at its first dot; a bare name is in "public". */
export function splitQualified(id: string): { schema: string; name: string } {
  const dot = id.indexOf(".");
  return dot === -1
    ? { schema: "public", name: id }
    : { schema: id.slice(0, dot), name: id.slice(dot + 1) };
}

export function literal(value: string): string {
  return format.literal(value);
}
