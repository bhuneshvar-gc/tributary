// Manual demo helper: `node --experimental-strip-types test/support/demo-servers.ts`
// starts a seeded source on :55431 and an empty target on :55432.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const source = await PGlite.create();
await source.exec(readFileSync(new URL("../fixtures/source.sql", import.meta.url), "utf8"));
await source.exec(`
  insert into parent_table values (1, 'p1'), (2, 'p2');
  insert into child_table values (10, 1, 'c10'), (11, 1, 'c11'), (20, 2, 'c20');
  insert into self_ref_table values (1, null), (2, 1), (3, 2);`);
const target = await PGlite.create();
for (const [db, port] of [
  [source, 55431],
  [target, 55432],
] as const) {
  await new PGLiteSocketServer({
    db,
    port,
    host: "127.0.0.1",
    maxConnections: 4,
  }).start();
}
console.log("ready");
