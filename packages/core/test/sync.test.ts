import { describe, expect, test } from "vitest";
import {
  type ProjectConfigInput,
  parseProjectConfig,
  plan,
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
    schema?: string;
    config?: ProjectConfigInput;
    fresh?: boolean;
    createSchema?: boolean;
    allowlist?: string[];
  } = {},
): Promise<SyncResult> {
  return sync({
    source: db.source.url,
    target: db.target.url,
    seeds: [{ table: `${options.schema ?? "public"}.${table}`, where }],
    config: parseProjectConfig(options.config ?? {}),
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

  expect(result.tables.map((t) => [t.table, t.rowsUpserted])).toEqual([
    ["public.parent_table", 1],
    ["public.child_table", 2],
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

  expect(result.tables.map((t) => [t.table, t.rowsUpserted, t.resumed])).toEqual([
    ["public.leaf_table", 1, false],
  ]);
  expect(await db.target.query("select * from leaf_table")).toEqual([{ id: 1, name: "after" }]);
});

test("re-running a key-only table counts its rows as upserted", async () => {
  await db.source.exec(`insert into tenant_table values (1), (2);`);
  await run("tenant_table", "true");

  const result = await run("tenant_table", "true");

  expect(result.tables[0]).toMatchObject({ table: "public.tenant_table", rowsUpserted: 2 });
});

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
        rowsUpserted: 3,
        rowsBackfilled: 2,
        rowsLeftNull: 0,
        resumed: false,
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
      rowsUpserted: 1,
      rowsBackfilled: 0,
      rowsLeftNull: 1,
    });
    expect(await db.target.query("select id, next_id from self_ref_table")).toEqual([
      { id: 2, next_id: null },
    ]);
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
    config: { dependencyBreaks: [{ table: "cycle_a", column: "b_id" }] },
  });

  expect(result.tables.map((t) => t.table)).toEqual(["public.cycle_a", "public.cycle_b"]);
  expect(await db.target.query("select id, b_id from cycle_a")).toEqual([{ id: 1, b_id: 1 }]);
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

    const result = await run("invoice", "id = 1", { schema: "billing" });

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

describe("resume", () => {
  test("an interrupted run skips the tables it already loaded", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table values (10, 1, 'bad');`);
    // A target-only check constraint makes the second table fail to load.
    await db.target.exec(`
      create table parent_table (id int primary key, name text not null);
      create table child_table (id int primary key, parent_id int not null references parent_table, name text not null check (name <> 'bad'));`);

    await expect(run("parent_table", "id = 1")).rejects.toThrow(/child_table/);
    await db.target.exec(`alter table child_table drop constraint child_table_name_check;`);
    const result = await run("parent_table", "id = 1");

    expect(result.tables.map((t) => [t.table, t.resumed])).toEqual([
      ["public.parent_table", true],
      ["public.child_table", false],
    ]);
    expect(await db.target.query("select count(*)::int as n from child_table")).toEqual([{ n: 1 }]);
  });

  test("a resume reloads an already-loaded table whose source rows changed since", async () => {
    await db.source.exec(`
      insert into parent_table values (1, 'p1');
      insert into child_table values (10, 1, 'bad');`);
    await db.target.exec(`
      create table parent_table (id int primary key, name text not null);
      create table child_table (id int primary key, parent_id int not null references parent_table, name text not null check (name <> 'bad'));`);

    await expect(run("parent_table", "id = 1")).rejects.toThrow(/child_table/);
    await db.source.exec(`update parent_table set name = 'renamed' where id = 1;`);
    await db.target.exec(`alter table child_table drop constraint child_table_name_check;`);
    const result = await run("parent_table", "id = 1");

    expect(result.tables.map((t) => [t.table, t.resumed])).toEqual([
      ["public.parent_table", false],
      ["public.child_table", false],
    ]);
    expect(await db.target.query("select name from parent_table")).toEqual([{ name: "renamed" }]);
  });

  test("fresh deletes the subset's rows and starts over instead of resuming", async () => {
    await db.source.exec(`insert into leaf_table values (1, 'one'), (2, 'two');`);
    await db.target.exec(`
      create table leaf_table (id int primary key, name text not null, note text);
      insert into leaf_table values (1, 'stale', 'target-only'), (3, 'three', 'outside the subset');`);

    const result = await run("leaf_table", "id = 1", { fresh: true });

    expect(result.tables[0]).toMatchObject({ rowsUpserted: 1, resumed: false });
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
