import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";

/**
 * An in-process Postgres (PGlite, real Postgres compiled to WASM) exposed
 * over the wire protocol, so the engine's `pg` client talks to it exactly
 * as it would a real server. No Docker needed.
 */
export interface TestPostgres {
  url: string;
  /** Run SQL directly against the instance (fixtures and assertions). */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function startPostgres(): Promise<TestPostgres> {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({
    db,
    port: 0,
    host: "127.0.0.1",
    maxConnections: 4,
  });
  await server.start();
  const url = `postgres://postgres@${server.getServerConn()}/postgres`;

  return {
    url,
    async query(sql, params) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        return (await client.query(sql, params)).rows;
      } finally {
        await client.end();
      }
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async close() {
      await server.stop();
      await db.close();
    },
  };
}
