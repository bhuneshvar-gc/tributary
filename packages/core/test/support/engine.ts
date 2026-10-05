import { readFileSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";
import { startPostgres, type TestPostgres } from "./postgres.js";

const fixture = readFileSync(new URL("../fixtures/source.sql", import.meta.url), "utf8");

/**
 * Fresh source (seeded with fixtures/source.sql) and empty target
 * Postgres instances for every test in the calling file.
 */
export function useDatabases(): { source: TestPostgres; target: TestPostgres } {
  const dbs = {} as { source: TestPostgres; target: TestPostgres };
  beforeEach(async () => {
    [dbs.source, dbs.target] = await Promise.all([startPostgres(), startPostgres()]);
    await dbs.source.exec(fixture);
  });
  afterEach(async () => {
    await Promise.all([dbs.source.close(), dbs.target.close()]);
  });
  return dbs;
}
