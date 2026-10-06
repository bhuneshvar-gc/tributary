import { describe, expect, test } from "vitest";
import {
  buildGraph,
  type Closure,
  computeClosure,
  connect,
  inspect,
  parseSchemaFile,
  type Traversal,
} from "../src/index.js";
import { useDatabases } from "./support/engine.js";

const db = useDatabases();

const polymorphic = {
  schema: {
    version: 1,
    tables: {
      poly_source_table: {
        polymorphic: {
          target_id: {
            typeColumn: "target_type",
            targets: { A: "poly_target_a.id", B: "poly_target_b.id" },
          },
        },
      },
    },
  },
};

async function closureOf(
  table: string,
  where: string,
  options: { schema?: unknown; traversal?: Traversal; strictCycles?: boolean } = {},
): Promise<Closure> {
  const file = parseSchemaFile(options.schema ?? { version: 1 });
  const graph = buildGraph(await inspect(db.source.url), file);
  const client = await connect(db.source.url);
  try {
    return await computeClosure(client, graph, [{ table: `public.${table}`, where }], {
      ...options,
      cycleBreaks: file.cycleBreaks,
    });
  } finally {
    await client.end();
  }
}

/** table -> sorted primary key values ("id" column) in the closure. */
function ids(closure: Closure): Record<string, string[]> {
  return Object.fromEntries(
    [...closure.rows].map(([table, rows]) => [
      table,
      [...rows.values()].map((r) => r.id ?? "").sort(),
    ]),
  );
}

test("a seed pulls in its required parents and its children", async () => {
  await db.source.exec(`
    insert into parent_table values (1, 'p1'), (2, 'p2');
    insert into child_table values (10, 1, 'c10'), (11, 1, 'c11'), (20, 2, 'c20');`);

  expect(ids(await closureOf("child_table", "id = 10"))).toEqual({
    "public.child_table": ["10"],
    "public.parent_table": ["1"],
  });
  expect(ids(await closureOf("parent_table", "id = 1"))).toEqual({
    "public.parent_table": ["1"],
    "public.child_table": ["10", "11"],
  });
});

test("several seeds produce one closure covering all of them", async () => {
  await db.source.exec(`
    insert into parent_table values (1, 'p1'), (2, 'p2');
    insert into child_table values (10, 1, 'c10'), (20, 2, 'c20');
    insert into leaf_table values (7, 'l7');`);
  const graph = buildGraph(await inspect(db.source.url));
  const client = await connect(db.source.url);
  try {
    const closure = await computeClosure(client, graph, [
      { table: "public.child_table", where: "id = 10" },
      { table: "public.parent_table", where: "id = 2" },
      { table: "public.leaf_table", where: "true" },
    ]);
    expect(ids(closure)).toEqual({
      "public.child_table": ["10", "20"],
      "public.parent_table": ["1", "2"],
      "public.leaf_table": ["7"],
    });
  } finally {
    await client.end();
  }
});

describe("traversal", () => {
  test("downstream-only doesn't fan out from a shared parent to its other children", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1'), (2, 'p2');
      insert into shared_table values (100);
      insert into member_table values (1, 1, 100), (2, 2, 100);`);

    expect(ids(await closureOf("parent_table", "id = 1"))).toEqual({
      "public.parent_table": ["1"],
      "public.member_table": ["1"],
      "public.shared_table": ["100"],
    });
  });

  test("full traversal fans out from every row", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1'), (2, 'p2');
      insert into shared_table values (100);
      insert into member_table values (1, 1, 100), (2, 2, 100);`);

    expect(ids(await closureOf("parent_table", "id = 1", { traversal: "full" }))).toEqual({
      "public.parent_table": ["1", "2"],
      "public.member_table": ["1", "2"],
      "public.shared_table": ["100"],
    });
  });
});

test("a composite foreign key pairs its columns correctly", async () => {
  await db.source.exec(`
    insert into tenant_table values (1), (2);
    insert into composite_parent_table values (1, 5, 'tenant1-5'), (2, 5, 'tenant2-5');
    insert into composite_child_table values (1, 5, 2, 'sku');`);

  const closure = await closureOf("composite_child_table", "id = 1");
  const parents = [...closure.rows.get("public.composite_parent_table")!.values()];
  expect(parents).toEqual([{ tenant_id: "2", id: "5" }]); // tenant 2's parent 5, not tenant 1's
  expect(ids(closure)["public.tenant_table"]).toEqual(["2"]);
});

describe("cycles", () => {
  test("a self-reference is auto-broken and reported", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null), (2, 1), (3, 2);`);

    const closure = await closureOf("self_ref_table", "id = 2");
    expect(closure.breaks).toEqual([
      { table: "public.self_ref_table", column: "next_id", auto: true },
    ]);
    // Row 3 references the seed, so it's downstream; row 1 is only its parent via the broken edge.
    expect(ids(closure)).toEqual({ "public.self_ref_table": ["2", "3"] });
  });

  test("a breakCycle from the schema file is applied, not auto", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null), (2, 1);`);

    const closure = await closureOf("self_ref_table", "id = 2", {
      schema: { version: 1, tables: { self_ref_table: { breakCycle: ["next_id"] } } },
    });
    expect(closure.breaks).toEqual([
      { table: "public.self_ref_table", column: "next_id", auto: false },
    ]);
  });

  test("strict cycles fail instead of guessing", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null), (2, 1);`);

    await expect(closureOf("self_ref_table", "id = 2", { strictCycles: true })).rejects.toThrow(
      /unresolved cycle: public\.self_ref_table\.next_id/,
    );
  });

  test("a root row with a null reference uses up no break", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null);`);

    expect((await closureOf("self_ref_table", "id = 1", { strictCycles: true })).breaks).toEqual(
      [],
    );
  });
});

describe("polymorphic associations", () => {
  test("each row follows the target its discriminator names", async () => {
    await db.source.exec(`
      insert into poly_target_a values (1, 'a1');
      insert into poly_target_b values (1, 'b1'), (2, 'b2');
      insert into poly_source_table values (1, 'A', 1), (2, 'B', 2);`);

    expect(ids(await closureOf("poly_source_table", "true", polymorphic))).toEqual({
      "public.poly_source_table": ["1", "2"],
      "public.poly_target_a": ["1"],
      "public.poly_target_b": ["2"],
    });
  });

  test("a target fans out to the rows pointing at it with its discriminator", async () => {
    await db.source.exec(`
      insert into poly_target_a values (1, 'a1');
      insert into poly_target_b values (1, 'b1');
      insert into poly_source_table values (1, 'A', 1), (2, 'B', 1);`);

    expect(ids(await closureOf("poly_target_a", "id = 1", polymorphic))).toEqual({
      "public.poly_target_a": ["1"],
      "public.poly_source_table": ["1"],
    });
  });

  test("an unknown discriminator value is skipped with a warning", async () => {
    await db.source.exec(`insert into poly_source_table values (1, 'Z', 1);`);

    const closure = await closureOf("poly_source_table", "id = 1", polymorphic);
    expect(ids(closure)).toEqual({ "public.poly_source_table": ["1"] });
    expect(closure.warnings).toEqual([
      'public.poly_source_table.target_type: unrecognized polymorphic type value "Z", no matching target in the schema file; skipped',
    ]);
  });
});

test("an unknown seed table is an error", async () => {
  await expect(closureOf("nope", "true")).rejects.toThrow(/no such table "public\.nope"/);
});

describe("round trips", () => {
  /** Runs a closure through a client that records every query it sends. */
  async function counted(seeds: { table: string; where: string }[]) {
    const graph = buildGraph(await inspect(db.source.url));
    const client = await connect(db.source.url);
    const queries: string[] = [];
    const counting = {
      query: (text: unknown, values?: unknown[]) => {
        queries.push(typeof text === "string" ? text : (text as { text: string }).text);
        return client.query(text as string, values);
      },
    };
    try {
      const closure = await computeClosure(counting, graph, seeds);
      return { closure, queries };
    } finally {
      await client.end();
    }
  }

  test("children of many rows are fetched in one query per edge, not one per row", async () => {
    await db.source.exec(`
      insert into parent_table select g, 'p' || g from generate_series(1, 200) g;
      insert into child_table select g, g, 'c' || g from generate_series(1, 200) g;`);

    const { closure, queries } = await counted([{ table: "public.parent_table", where: "true" }]);

    expect(ids(closure)["public.child_table"]).toHaveLength(200);
    expect(queries.length).toBeLessThanOrEqual(4);
  });

  test("a lookup returning hundreds of thousands of rows doesn't overflow the stack", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table select g, 1, 'c' from generate_series(1, 200000) g;`);

    const { closure } = await counted([{ table: "public.parent_table", where: "id = 1" }]);

    expect(closure.rows.get("public.child_table")?.size).toBe(200_000);
  }, 120_000);

  test("a parent shared by many rows is fetched once", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table select g, 1, 'c' || g from generate_series(1, 300) g;`);

    const { closure, queries } = await counted([{ table: "public.child_table", where: "true" }]);

    expect(ids(closure)["public.parent_table"]).toEqual(["1"]);
    expect(queries.filter((q) => /FROM public\.parent_table\b/.test(q))).toHaveLength(1);
  });

  test("a parent already collected isn't fetched again", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table values (10, 1, 'c10');`);

    const { queries } = await counted([
      { table: "public.parent_table", where: "id = 1" },
      { table: "public.child_table", where: "id = 10" },
    ]);

    // The seed query is the only one that touches parent_table.
    expect(queries.filter((q) => /FROM public\.parent_table\b/.test(q))).toHaveLength(1);
  });

  test("composite keys are batched too, keeping their column pairing", async () => {
    await db.source.exec(`
      insert into tenant_table values (1), (2);
      insert into composite_parent_table values (1, 5, 't1'), (2, 5, 't2'), (1, 6, 't1-6');
      insert into composite_child_table values (1, 5, 2, 'a'), (2, 6, 1, 'b'), (3, 5, 2, 'c');`);

    const { closure, queries } = await counted([
      { table: "public.composite_child_table", where: "true" },
    ]);

    const parents = [...closure.rows.get("public.composite_parent_table")!.values()]
      .map((r) => `${r.tenant_id}/${r.id}`)
      .sort();
    expect(parents).toEqual(["1/6", "2/5"]);
    expect(queries.filter((q) => /FROM public\.composite_parent_table\b/.test(q))).toHaveLength(1);
  });
});

test("progress is reported as rows are collected", async () => {
  await db.source.exec(`
    insert into parent_table values (1, 'p1');
    insert into child_table values (10, 1, 'c10'), (11, 1, 'c11');`);
  const graph = buildGraph(await inspect(db.source.url));
  const client = await connect(db.source.url);
  const reports: { rows: number; tables: number }[] = [];
  try {
    await computeClosure(client, graph, [{ table: "public.parent_table", where: "id = 1" }], {
      onProgress: (p) => reports.push({ rows: p.rows, tables: p.tables }),
    });
  } finally {
    await client.end();
  }
  expect(reports.at(-1)).toEqual({ rows: 3, tables: 2 });
  expect(reports.length).toBeGreaterThan(1);
});

test("the closure keeps only the columns needed to follow relations, not whole rows", async () => {
  await db.source.exec(`
    insert into parent_table values (1, 'p1');
    insert into child_table values (10, 1, 'c10');`);

  const closure = await closureOf("parent_table", "id = 1");

  // child_table: its key and the foreign key column; "name" stays in the database.
  expect([...closure.rows.get("public.child_table")!.values()]).toEqual([
    { id: "10", parent_id: "1" },
  ]);
  expect([...closure.rows.get("public.parent_table")!.values()]).toEqual([{ id: "1" }]);
});
