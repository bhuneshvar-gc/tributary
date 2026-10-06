import { describe, expect, test } from "vitest";
import { assertDistinctDatabases, connect } from "../src/index.js";
import { useDatabases } from "./support/engine.js";

const db = useDatabases();

/** A client whose role can't read pg_control_system(), like most managed-database users. */
let roles = 0;
async function unprivileged(url: string) {
  const client = await connect(url);
  // Roles are cluster-wide on a real server, so each client gets its own.
  const role = `app_${process.pid}_${++roles}`;
  await client.query(`CREATE ROLE ${role}`);
  await client.query("REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC");
  await client.query(`SET ROLE ${role}`);
  return client;
}

describe("assertDistinctDatabases without access to the system identifier", () => {
  test("still detects the same database reached by two connections", async () => {
    const [a, b] = [await unprivileged(db.source.url), await unprivileged(db.source.url)];
    try {
      expect(
        (await a.query("select has_function_privilege('pg_control_system()', 'execute') as p"))
          .rows,
      ).toEqual([{ p: "f" }]);
      await expect(assertDistinctDatabases(a, b)).rejects.toThrow(/same database/);
    } finally {
      await Promise.all([a.end(), b.end()]);
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
