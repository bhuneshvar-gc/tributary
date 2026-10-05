import { describe, expect, test } from "vitest";
import { assertDistinctDatabases, connect } from "../src/index.js";
import { useDatabases } from "./support/engine.js";

const db = useDatabases();

/** A client whose role can't read pg_control_system(), like most managed-database users. */
async function unprivileged(url: string) {
  const client = await connect(url);
  await client.query("CREATE ROLE app");
  await client.query("REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC");
  await client.query("SET ROLE app");
  return client;
}

describe("assertDistinctDatabases without access to the system identifier", () => {
  // PGlite multiplexes connections onto one session, so one client stands
  // in for "two connections to the same database".
  test("still detects the same database", async () => {
    const a = await unprivileged(db.source.url);
    try {
      expect(
        (await a.query("select has_function_privilege('pg_control_system()', 'execute') as p"))
          .rows,
      ).toEqual([{ p: "f" }]);
      await expect(assertDistinctDatabases(a, a)).rejects.toThrow(/same database/);
    } finally {
      await a.end();
    }
  });

  test("allows two different databases", async () => {
    const [a, b] = [await unprivileged(db.source.url), await unprivileged(db.target.url)];
    try {
      await expect(assertDistinctDatabases(a, b)).resolves.toBeUndefined();
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  test("works inside a read-only transaction", async () => {
    const [a, b] = [await unprivileged(db.source.url), await unprivileged(db.target.url)];
    try {
      await a.query("BEGIN READ ONLY");
      await assertDistinctDatabases(a, b);
      expect((await a.query("select 1 as ok")).rows).toEqual([{ ok: "1" }]);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });
});
