import { beforeEach, describe, expect, test } from "vitest";
import {
  connect,
  parseSchemaFile,
  plan,
  type SubsetProgress,
  type SyncResult,
  sync,
  TargetNotAllowedError,
} from "../src/index.js";
import { useDatabases } from "./support/engine.js";

const db = useDatabases();

function run(
  table: string,
  where: string,
  options: {
    /** Postgres schema of the seed table (default public). */
    dbSchema?: string;
    /** Schema file contents. */
    schemaFile?: unknown;
    fresh?: boolean;
    createSchema?: boolean;
    allowlist?: string[];
  } = {},
): Promise<SyncResult> {
  return sync({
    source: db.source.url,
    target: db.target.url,
    seeds: [{ table: `${options.dbSchema ?? "public"}.${table}`, where }],
    schema: parseSchemaFile(options.schemaFile ?? { version: 1 }),
    allowlist: options.allowlist ?? ["127.0.0.1"],
    ...(options.fresh !== undefined && { fresh: options.fresh }),
    ...(options.createSchema !== undefined && {
      createSchema: options.createSchema,
    }),
  });
}

test("copies the subset into an empty target, creating its tables", async () => {
  await db.source.exec(`
    insert into parent_table values (1, 'p1'), (2, 'p2');
    insert into child_table values (10, 1, 'c10'), (11, 1, 'c11'), (20, 2, 'c20');`);

  const result = await run("parent_table", "id = 1");

  expect(result.tables.map((t) => [t.table, t.mode, t.rowsWritten])).toEqual([
    ["public.parent_table", "new table", 1],
    ["public.child_table", "new table", 2],
  ]);
  expect(result.schema.tablesCreated).toEqual(["public.child_table", "public.parent_table"]);
  expect(await db.target.query("select id, parent_id, name from child_table order by id")).toEqual([
    { id: 10, parent_id: 1, name: "c10" },
    { id: 11, parent_id: 1, name: "c11" },
  ]);
  expect(
    await db.target.query(
      "select conname from pg_constraint where conrelid = 'child_table'::regclass and contype = 'f'",
    ),
  ).toEqual([{ conname: "child_table_parent_id_fkey" }]);
});

test("re-running updates changed rows in place instead of failing or duplicating", async () => {
  await db.source.exec(`insert into leaf_table values (1, 'before');`);
  await run("leaf_table", "id = 1");
  await db.source.exec(`update leaf_table set name = 'after' where id = 1;`);

  const result = await run("leaf_table", "id = 1");

  expect(result.tables.map((t) => [t.table, t.mode, t.rowsWritten, t.rowsUnchanged])).toEqual([
    ["public.leaf_table", "upsert", 1, 0],
  ]);
  expect(await db.target.query("select * from leaf_table")).toEqual([{ id: 1, name: "after" }]);
});

test("re-running a key-only table writes nothing: its rows are already there", async () => {
  await db.source.exec(`insert into tenant_table values (1), (2);`);
  await run("tenant_table", "true");

  const result = await run("tenant_table", "true");

  expect(result.tables[0]).toMatchObject({
    table: "public.tenant_table",
    rowsWritten: 0,
    rowsUnchanged: 2,
  });
});

describe("re-syncs write only what changed", () => {
  const versions = () =>
    db.target.query("select id, xmin::text as version from leaf_table order by id");

  test("nothing changed: no row is rewritten", async () => {
    await db.source.exec(`insert into leaf_table values (1, 'a'), (2, 'b'), (3, 'c');`);
    await run("leaf_table", "true");
    const before = await versions();

    const result = await run("leaf_table", "true");

    expect(result.tables[0]).toMatchObject({ mode: "upsert", rowsWritten: 0, rowsUnchanged: 3 });
    expect(await versions()).toEqual(before);
  });

  test("one row changed: only that row is rewritten", async () => {
    await db.source.exec(`insert into leaf_table values (1, 'a'), (2, 'b'), (3, 'c');`);
    await run("leaf_table", "true");
    const before = await versions();
    await db.source.exec(`update leaf_table set name = 'B' where id = 2;`);

    const result = await run("leaf_table", "true");

    expect(result.tables[0]).toMatchObject({ rowsWritten: 1, rowsUnchanged: 2 });
    const after = await versions();
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(after[1]).not.toEqual(before[1]);
    expect(await db.target.query("select name from leaf_table where id = 2")).toEqual([
      { name: "B" },
    ]);
  });

  test("columns whose type has no = operator (json, point, xml) are compared too", async () => {
    await db.source.exec(`
      insert into no_equality_table values
        (1, '{"a": 1}', '(1,2)', array['[1]'::json], 1.0, '<a/>'),
        (2, '{"b": 2}', '(3,4)', null, 2.0, '<b/>');`);
    await run("no_equality_table", "true");

    expect((await run("no_equality_table", "true")).tables[0]).toMatchObject({
      rowsWritten: 0,
      rowsUnchanged: 2,
    });

    await db.source.exec(
      `update no_equality_table set doc = '{"a": 2}', n = 1.00, x = '<c/>' where id = 1;`,
    );
    expect((await run("no_equality_table", "true")).tables[0]).toMatchObject({
      rowsWritten: 1,
      rowsUnchanged: 1,
    });
    expect(
      await db.target.query(
        "select doc::text, n::text, x::text from no_equality_table where id = 1",
      ),
    ).toEqual([{ doc: '{"a": 2}', n: "1.00", x: "<c/>" }]);
  });
});

test("text keys with quotes, backslashes, braces and commas are matched exactly", async () => {
  const keys = [
    `it's`,
    `back\\slash`,
    `{braces}`,
    `a,b`,
    `"quoted"`,
    `NULL`,
    ` spaced `,
    `ünïcødé`,
  ];
  await db.source.query(
    "insert into text_key_table select k, 'v-' || k from unnest($1::text[]) k",
    [keys],
  );
  await db.source.exec(`insert into text_key_table values ('not-selected', 'x');`);

  await run("text_key_table", "id <> 'not-selected'");

  const loaded = await db.target.query<{ id: string }>("select id from text_key_table order by id");
  expect(loaded.map((r) => r.id).sort()).toEqual([...keys].sort());
});

test("more keys than fit in one COPY are all loaded", async () => {
  await db.source.exec(
    `insert into leaf_table select g, 'n' || g from generate_series(1, 120000) g;`,
  );

  const result = await run("leaf_table", "id % 2 = 0");

  expect(result.tables[0]).toMatchObject({ rowsWritten: 60_000 });
  expect(
    await db.target.query(
      "select count(*)::int as n, min(id)::int as lo, max(id)::int as hi from leaf_table",
    ),
  ).toEqual([{ n: 60_000, lo: 2, hi: 120_000 }]);
}, 120_000);

test("a composite foreign key loads with its columns paired", async () => {
  await db.source.exec(`
    insert into tenant_table values (1), (2);
    insert into composite_parent_table values (1, 5, 'tenant1-5'), (2, 5, 'tenant2-5');
    insert into composite_child_table values (1, 5, 2, 'sku');`);

  await run("composite_child_table", "id = 1");

  expect(await db.target.query("select tenant_id, id, name from composite_parent_table")).toEqual([
    { tenant_id: 2, id: 5, name: "tenant2-5" },
  ]);
});

describe("self-references", () => {
  test("are loaded NULL first, then backfilled", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null), (2, 1), (3, 2);`);

    const result = await run("self_ref_table", "id = 1");

    expect(result.tables).toEqual([
      {
        table: "public.self_ref_table",
        mode: "new table",
        rowsWritten: 3,
        rowsUnchanged: 0,
        rowsBackfilled: 2,
        rowsLeftNull: 0,
      },
    ]);
    expect(await db.target.query("select id, next_id from self_ref_table order by id")).toEqual([
      { id: 1, next_id: null },
      { id: 2, next_id: 1 },
      { id: 3, next_id: 2 },
    ]);
  });

  test("stay NULL where the referenced row is outside the subset", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null), (2, 1);`);

    const result = await run("self_ref_table", "id = 2");

    expect(result.tables[0]).toMatchObject({
      rowsWritten: 1,
      rowsBackfilled: 0,
      rowsLeftNull: 1,
    });
    expect(await db.target.query("select id, next_id from self_ref_table")).toEqual([
      { id: 2, next_id: null },
    ]);
  });

  test("follow the source on a re-sync: cleared, or now outside the subset, become NULL", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null), (2, 1), (3, 2);`);
    await run("self_ref_table", "id = 1");
    await db.source.exec(`update self_ref_table set next_id = null where id = 3;`);

    // Row 2's parent (1) isn't in this subset; row 3's reference was cleared.
    const result = await run("self_ref_table", "id >= 2");

    // Clearing a reference isn't a restore: nothing backfilled, one row cut at the boundary.
    expect(result.tables[0]).toMatchObject({ rowsBackfilled: 0, rowsLeftNull: 1 });
    expect(await db.target.query("select id, next_id from self_ref_table order by id")).toEqual([
      { id: 1, next_id: null },
      { id: 2, next_id: null },
      { id: 3, next_id: null },
    ]);
    expect((await run("self_ref_table", "id >= 2")).tables[0]).toMatchObject({
      rowsBackfilled: 0,
    });
  });

  test("that are NOT NULL fail preflight naming the column", async () => {
    await db.source.exec(`insert into self_ref_strict_table values (1, 1);`);

    await expect(run("self_ref_strict_table", "id = 1")).rejects.toThrow(
      /public\.self_ref_strict_table\.next_id .*is NOT NULL/,
    );
    expect(await db.target.query("select to_regclass('self_ref_strict_table') as t")).toEqual([
      { t: null },
    ]);
  });
});

test("a multi-table cycle loads with a dependency break, backfilling the broken column", async () => {
  await db.source.exec(`
    begin;
    set constraints all deferred;
    insert into cycle_a values (1, null);
    insert into cycle_b values (1, 1);
    update cycle_a set b_id = 1 where id = 1;
    commit;`);

  const result = await run("cycle_a", "id = 1", {
    schemaFile: { version: 1, tables: { cycle_a: { breakCycle: ["b_id"] } } },
  });

  expect(result.tables.map((t) => t.table)).toEqual(["public.cycle_a", "public.cycle_b"]);
  expect(await db.target.query("select id, b_id from cycle_a")).toEqual([{ id: 1, b_id: 1 }]);
});

test("a broken cycle column follows the source on a re-sync", async () => {
  await db.source.exec(`
    begin;
    set constraints all deferred;
    insert into cycle_a values (1, null);
    insert into cycle_b values (1, 1);
    update cycle_a set b_id = 1 where id = 1;
    commit;`);
  const schemaFile = { version: 1, tables: { cycle_a: { breakCycle: ["b_id"] } } };
  await run("cycle_a", "id = 1", { schemaFile });
  await db.source.exec(`update cycle_a set b_id = null where id = 1;`);

  await run("cycle_a", "id = 1", { schemaFile });

  expect(await db.target.query("select id, b_id from cycle_a")).toEqual([{ id: 1, b_id: null }]);
});

describe("custom types", () => {
  test("a missing enum type is created on target with the same labels", async () => {
    await db.source.exec(`insert into enum_table values (1, 'inactive');`);

    const result = await run("enum_table", "id = 1");

    expect(result.schema.typesCreated).toEqual(["public.enum_status"]);
    expect(
      await db.target.query("select unnest(enum_range(null::enum_status))::text as label"),
    ).toEqual([{ label: "active" }, { label: "inactive" }]);
  });

  test("an array of a missing enum creates the enum", async () => {
    await db.source.exec(`insert into enum_array_table values (1, '{happy,sad}');`);

    const result = await run("enum_array_table", "id = 1");

    expect(result.schema.typesCreated).toEqual(["public.mood"]);
    expect(await db.target.query("select moods::text from enum_array_table")).toEqual([
      { moods: "{happy,sad}" },
    ]);
  });

  test("enums are created in their own schema, same-named ones kept apart", async () => {
    await db.source.exec(
      `insert into billing.invoice values (1, 'paid', 'closed', '{draft,paid}');`,
    );

    const result = await run("invoice", "id = 1", { dbSchema: "billing" });

    expect(result.schema.typesCreated.sort()).toEqual([
      "billing.invoice_status",
      "public.invoice_status",
    ]);
    const labels = (type: string) =>
      db.target.query(`select unnest(enum_range(null::${type}))::text as label`);
    expect(await labels("billing.invoice_status")).toEqual([{ label: "draft" }, { label: "paid" }]);
    expect(await labels("public.invoice_status")).toEqual([{ label: "open" }, { label: "closed" }]);
    expect(
      await db.target.query(
        "select status::text, legacy::text, history::text from billing.invoice",
      ),
    ).toEqual([{ status: "paid", legacy: "closed", history: "{draft,paid}" }]);
  });

  test("a missing domain is a named error", async () => {
    await db.source.exec(`insert into domain_table values (1, 5);`);

    await expect(run("domain_table", "id = 1")).rejects.toThrow(
      /public\.domain_table\.amount uses type "public\.positive_int", which doesn't exist on the target and isn't an enum/,
    );
  });
});

test("values arrive exactly, with no precision lost on the way", async () => {
  await db.source.exec(`
    insert into typed_table values (
      9007199254740993, '2026-10-05 12:34:56.123456+00', 12345678.1234, 'abc',
      '{"big": 12345678901234567890, "nested": [1, {"a": null}]}', '{"x","y,z",NULL}', '\\x00ff10'
    );`);

  await run("typed_table", "true");

  const text =
    "select id::text, at::text, amount::text, code, payload::text, tags::text, blob::text from typed_table";
  expect(await db.target.query(text)).toEqual(await db.source.query(text));
});

describe("re-running after a failure", () => {
  const failingChild = `
    create table parent_table (id int primary key, name text not null);
    create table child_table (id int primary key, parent_id int not null references parent_table, name text not null check (name <> 'bad'));`;

  test("tables loaded before the failure aren't rewritten", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table values (10, 1, 'bad');`);
    await db.target.exec(failingChild);

    await expect(run("parent_table", "id = 1")).rejects.toThrow(/child_table/);
    await db.target.exec(`alter table child_table drop constraint child_table_name_check;`);
    const result = await run("parent_table", "id = 1");

    expect(result.tables.map((t) => [t.table, t.rowsWritten, t.rowsUnchanged])).toEqual([
      ["public.parent_table", 0, 1],
      ["public.child_table", 1, 0],
    ]);
  });

  test("source changes since the failure are picked up", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table values (10, 1, 'bad');`);
    await db.target.exec(failingChild);

    await expect(run("parent_table", "id = 1")).rejects.toThrow(/child_table/);
    await db.source.exec(`update parent_table set name = 'renamed' where id = 1;`);
    await db.target.exec(`alter table child_table drop constraint child_table_name_check;`);
    const result = await run("parent_table", "id = 1");

    expect(result.tables[0]).toMatchObject({ table: "public.parent_table", rowsWritten: 1 });
    expect(await db.target.query("select name from parent_table")).toEqual([{ name: "renamed" }]);
  });

  test("fresh deletes the subset's rows and loads them again", async () => {
    await db.source.exec(`insert into leaf_table values (1, 'one'), (2, 'two');`);
    await db.target.exec(`
      create table leaf_table (id int primary key, name text not null, note text);
      insert into leaf_table values (1, 'stale', 'target-only'), (3, 'three', 'outside the subset');`);

    const result = await run("leaf_table", "id = 1", { fresh: true });

    expect(result.tables[0]).toMatchObject({ rowsWritten: 1 });
    expect(await db.target.query("select id, name, note from leaf_table order by id")).toEqual([
      { id: 1, name: "one", note: null },
      { id: 3, name: "three", note: "outside the subset" },
    ]);
  });
});

test("an existing target table missing a source column is rejected", async () => {
  await db.source.exec(`insert into leaf_table values (1, 'one');`);
  await db.target.exec(`create table leaf_table (id int primary key);`);

  await expect(run("leaf_table", "id = 1")).rejects.toThrow(/missing column "name"/);
});

test("with schema creation off, a missing target table is an error", async () => {
  await db.source.exec(`insert into leaf_table values (1, 'one');`);

  await expect(run("leaf_table", "id = 1", { createSchema: false })).rejects.toThrow(
    /missing 1 table\(s\) .*: public\.leaf_table/,
  );
});

describe("safety guards", () => {
  test("a target outside the allowlist is refused before anything is touched", async () => {
    await db.source.exec(`insert into leaf_table values (1, 'one');`);

    await expect(run("leaf_table", "id = 1", { allowlist: [] })).rejects.toThrow(
      TargetNotAllowedError,
    );
    expect(await db.target.query("select to_regclass('leaf_table') as t")).toEqual([{ t: null }]);
  });

  test("syncing a database into itself is refused", async () => {
    await db.source.exec(`insert into leaf_table values (1, 'one');`);

    await expect(
      sync({
        source: db.source.url,
        target: db.source.url,
        seeds: [{ table: "public.leaf_table", where: "id = 1" }],
        allowlist: ["127.0.0.1"],
      }),
    ).rejects.toThrow(/source and target are the same database/);
  });

  test("the seed predicate can't write to the source", async () => {
    await db.source.exec(`
      insert into leaf_table values (1, 'one');
      create function sneaky() returns boolean language sql as $$ delete from leaf_table; select true $$;`);

    await expect(run("leaf_table", "sneaky()")).rejects.toThrow(/read-only transaction/);
    expect(await db.source.query("select count(*)::int as n from leaf_table")).toEqual([{ n: 1 }]);
  });

  test("the seed predicate can't smuggle in extra statements to end the read-only transaction", async () => {
    await db.source.exec(`insert into leaf_table values (1, 'one');`);

    await expect(
      run("leaf_table", "true); COMMIT; DELETE FROM leaf_table; SELECT (1"),
    ).rejects.toThrow(/multiple commands/);
    expect(await db.source.query("select count(*)::int as n from leaf_table")).toEqual([{ n: 1 }]);
  });
});

test("plan reports row counts in load order and how each table was reached", async () => {
  await db.source.exec(`
    insert into parent_table values (1, 'p1');
    insert into child_table values (10, 1, 'c10'), (11, 1, 'c11');
    insert into self_ref_table values (1, null), (2, 1);`);

  expect(
    await plan({
      source: db.source.url,
      seeds: [{ table: "public.parent_table", where: "id = 1" }],
    }),
  ).toEqual({
    tables: [
      { table: "public.parent_table", rows: 1, via: "seed" },
      {
        table: "public.child_table",
        rows: 2,
        via: "public.child_table.parent_id -> public.parent_table.id",
      },
    ],
    totalRows: 3,
    breaks: [],
    warnings: [],
    durationMs: expect.any(Number),
  });
  const selfRef = await plan({
    source: db.source.url,
    seeds: [{ table: "public.self_ref_table", where: "id = 2" }],
  });
  expect(selfRef.tables).toEqual([
    {
      table: "public.self_ref_table",
      rows: 1,
      via: "seed",
      break: { table: "public.self_ref_table", column: "next_id", auto: true },
    },
  ]);
});

describe("progress", () => {
  /** Runs a sync of parent 1 and its child, returning its events and result. */
  async function tracked() {
    const events: SubsetProgress[] = [];
    const result = await sync({
      source: db.source.url,
      target: db.target.url,
      seeds: [{ table: "public.parent_table", where: "id = 1" }],
      allowlist: ["127.0.0.1"],
      onProgress: (e) => events.push(e),
    });
    // Phases in order, repeats collapsed.
    const phases = events.map((e) => e.phase).filter((p, i, all) => p !== all[i - 1]);
    return { events, phases, result };
  }

  beforeEach(async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table values (10, 1, 'c10'), (11, 1, 'c11');`);
  });

  test("a first sync reports every step, with live row counts per table", async () => {
    const { events, phases, result } = await tracked();

    expect(phases).toEqual([
      "inspecting",
      "collecting",
      "preparing",
      "copying",
      "loaded",
      "copying",
      "loaded",
      "analyzing",
    ]);
    expect(events.filter((e) => e.phase === "collecting").at(-1)).toMatchObject({
      rows: 3,
      tables: 2,
    });
    expect(events.filter((e) => e.phase === "copying").at(-1)).toEqual({
      phase: "copying",
      table: "public.child_table",
      index: 2,
      total: 2,
      rows: 2,
      totalRows: 2,
    });
    expect(events.filter((e) => e.phase === "loaded")).toEqual([
      {
        phase: "loaded",
        table: "public.parent_table",
        index: 1,
        total: 2,
        mode: "new table",
        written: 1,
        unchanged: 0,
      },
      {
        phase: "loaded",
        table: "public.child_table",
        index: 2,
        total: 2,
        mode: "new table",
        written: 2,
        unchanged: 0,
      },
    ]);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("a re-sync reports merging, and has nothing to analyze when nothing changed", async () => {
    await tracked();

    const { phases } = await tracked();

    expect(phases).toEqual([
      "inspecting",
      "collecting",
      "preparing",
      "copying",
      "merging",
      "loaded",
      "copying",
      "merging",
      "loaded",
    ]);
  });

  test("self-references report backfilling", async () => {
    await db.source.exec(`insert into self_ref_table values (1, null), (2, 1);`);
    const events: SubsetProgress[] = [];

    await sync({
      source: db.source.url,
      target: db.target.url,
      seeds: [{ table: "public.self_ref_table", where: "true" }],
      allowlist: ["127.0.0.1"],
      onProgress: (e) => events.push(e),
    });

    expect(events.filter((e) => e.phase === "backfilling")).toEqual([
      { phase: "backfilling", table: "public.self_ref_table", index: 1, total: 1 },
    ]);
  });
});

test("an ignored foreign key onto a unique, non-key column is backfilled", async () => {
  await db.source.exec(`
    insert into code_parent_table values (1, 'A'), (2, 'B');
    insert into code_child_table values (10, 'B'), (11, null);`);

  const result = await sync({
    source: db.source.url,
    target: db.target.url,
    allowlist: ["127.0.0.1"],
    seeds: [
      { table: "public.code_parent_table", where: "true" },
      { table: "public.code_child_table", where: "true" },
    ],
    schema: parseSchemaFile({
      version: 1,
      tables: { code_child_table: { ignore: ["parent_code"] } },
    }),
  });

  expect(result.tables.find((t) => t.table === "public.code_child_table")).toMatchObject({
    rowsBackfilled: 1,
    rowsLeftNull: 0,
  });
  expect(await db.target.query("select id, parent_code from code_child_table order by id")).toEqual(
    [
      { id: 10, parent_code: "B" },
      { id: 11, parent_code: null },
    ],
  );
});

test("an ignored foreign key follows the source on a re-sync", async () => {
  await db.source.exec(`
    insert into code_parent_table values (1, 'A'), (2, 'B');
    insert into code_child_table values (10, 'B');`);
  const options = {
    source: db.source.url,
    target: db.target.url,
    allowlist: ["127.0.0.1"],
    seeds: [
      { table: "public.code_parent_table", where: "true" },
      { table: "public.code_child_table", where: "true" },
    ],
    schema: parseSchemaFile({
      version: 1,
      tables: { code_child_table: { ignore: ["parent_code"] } },
    }),
  };
  await sync(options);
  await db.source.exec(`update code_child_table set parent_code = null where id = 10;`);

  await sync(options);

  expect(await db.target.query("select id, parent_code from code_child_table")).toEqual([
    { id: 10, parent_code: null },
  ]);
});

test("a foreign key onto the primary key's columns in another order adds no unique key", async () => {
  await db.source.exec(`
    insert into tenant_table values (1);
    insert into composite_parent_table values (1, 5, 'p');
    insert into composite_child_table values (1, 5, 1, 'sku');`);

  await run("composite_child_table", "id = 1");

  expect(
    await db.target.query(
      "select count(*)::int as n from pg_constraint where contype = 'u' and conrelid = 'composite_parent_table'::regclass",
    ),
  ).toEqual([{ n: 0 }]);
});

test("a foreign key the existing target table can't take is skipped with a warning", async () => {
  // On the target, code isn't unique, so a foreign key can't reference it.
  await db.target.exec(`create table code_parent_table (id int primary key, code text not null);`);
  await db.source.exec(`
    insert into code_parent_table values (1, 'A');
    insert into code_child_table values (10, 'A');`);

  const result = await run("code_child_table", "true");

  expect(result.schema.warnings).toEqual([
    expect.stringMatching(/did not create foreign key code_child_table_parent_code_fkey/),
  ]);
  expect(await db.target.query("select id, parent_code from code_child_table")).toEqual([
    { id: 10, parent_code: "A" },
  ]);
});

test("a failed ANALYZE is a warning, not a failed sync", async () => {
  await db.source.exec(`insert into leaf_table values (1, 'a');`);
  await run("leaf_table", "true");
  await db.source.exec(`update leaf_table set name = 'b' where id = 1;`);
  // Another session's lock blocks ANALYZE (not the load), which gives up after lock_timeout.
  const blocker = await connect(db.target.url);
  try {
    await blocker.query("begin; lock table leaf_table in share update exclusive mode");
    const target = new URL(db.target.url);
    target.searchParams.set("options", "-c lock_timeout=100");

    const result = await sync({
      source: db.source.url,
      target: target.toString(),
      allowlist: ["127.0.0.1"],
      seeds: [{ table: "public.leaf_table", where: "true" }],
      schema: parseSchemaFile({ version: 1 }),
    });

    expect(result.warnings).toEqual([
      expect.stringMatching(/could not analyze public\.leaf_table/),
    ]);
    expect(result.tables[0]).toMatchObject({ rowsWritten: 1 });
  } finally {
    await blocker.end();
  }
  expect(await db.target.query("select status from _tributary.runs")).toEqual([
    { status: "completed" },
  ]);
});
