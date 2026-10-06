import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Superuser URL of the throwaway test cluster, without a database. */
    pgBaseUrl: string;
  }
}

/**
 * A fresh, empty database on the test run's throwaway Postgres cluster
 * (see global-postgres.ts). Real Postgres, so COPY and everything else
 * behaves exactly as in production.
 */
export interface TestPostgres {
  url: string;
  /** Run SQL directly against the database (fixtures and assertions). */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Run one or more statements (no parameters). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function startPostgres(): Promise<TestPostgres> {
  const base = inject("pgBaseUrl");
  const name = `t_${randomBytes(6).toString("hex")}`;
  await withClient(`${base}/postgres`, (c) => c.query(`CREATE DATABASE ${name}`));
  const url = `${base}/${name}`;
  return {
    url,
    query: (sql, params) => withClient(url, async (c) => (await c.query(sql, params)).rows),
    exec: (sql) => withClient(url, async (c) => void (await c.query(sql))),
    close: () =>
      withClient(
        `${base}/postgres`,
        async (c) => void (await c.query(`DROP DATABASE ${name} WITH (FORCE)`)),
      ),
  };
}
