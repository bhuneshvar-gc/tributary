import { parse } from "pg-connection-string";
import type { Queryable } from "./db.js";

export class TargetNotAllowedError extends Error {
  constructor(readonly host: string) {
    super(
      `refusing to write: target host "${host}" is not in the target allowlist (an empty allowlist denies every target)`,
    );
    this.name = "TargetNotAllowedError";
  }
}

/** The host a connection string points at; a unix socket directory for socket connections. */
export function connectionHost(url: string): string {
  return parse(url).host || "localhost";
}

function matches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p.startsWith("*.")) return host.endsWith(p.slice(1));
  return host === p;
}

/**
 * Throws unless the connection string's host matches an allowlist entry:
 * an exact host ("localhost", "/var/run/postgresql") or a "*.suffix"
 * wildcard matching any subdomain depth. An empty allowlist denies every
 * target, so writes need an explicit opt-in per environment.
 */
export function checkTargetAllowed(
  url: string,
  allowlist: readonly string[],
): void {
  const host = connectionHost(url).toLowerCase();
  if (!allowlist.some((p) => matches(host, p)))
    throw new TargetNotAllowedError(host);
}

interface DatabaseIdentity {
  /** Server start time + database oid + name: readable by any role, independent of network path. */
  instance: string;
  /** Cluster system identifier + database name, when the role may read pg_control_system(). */
  cluster: string | null;
}

/**
 * Identifies the database a client is connected to. Never fails a query
 * (an error would abort a surrounding transaction): the privilege to read
 * the system identifier is checked first.
 */
async function databaseIdentity(db: Queryable): Promise<DatabaseIdentity> {
  const { rows } = await db.query(`
    select pg_postmaster_start_time()::text as started,
      (select oid::text from pg_database where datname = current_database()) as oid,
      current_database() as db,
      has_function_privilege('pg_control_system()', 'execute') as can_read_cluster`);
  const r = rows[0]!;
  let cluster: string | null = null;
  if (r.can_read_cluster === "t") {
    const sid = await db.query(
      "select system_identifier::text as sid from pg_control_system()",
    );
    cluster = `${sid.rows[0]!.sid}/${r.db}`;
  }
  return { instance: `${r.started}/${r.oid}/${r.db}`, cluster };
}

/**
 * Refuses to sync a database into itself, whether reached through two
 * different addresses (a pooler and a direct connection) or as a replica
 * of the target cluster.
 */
export async function assertDistinctDatabases(
  source: Queryable,
  target: Queryable,
): Promise<void> {
  const a = await databaseIdentity(source);
  const b = await databaseIdentity(target);
  if (
    a.instance === b.instance ||
    (a.cluster !== null && a.cluster === b.cluster)
  ) {
    throw new Error(
      "refusing to sync: source and target are the same database",
    );
  }
}
