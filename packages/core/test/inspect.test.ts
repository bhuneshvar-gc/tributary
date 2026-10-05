import { expect, test } from "vitest";
import { inspect } from "../src/index.js";
import { useDatabases } from "./support/engine.js";

const db = useDatabases();

test("inspect reports base tables with columns, keys and composite foreign keys", async () => {
  const schema = await inspect(db.source.url);

  expect(schema.tables.map((t) => t.name)).not.toContain("leaf_view");
  const child = schema.tables.find((t) => t.name === "composite_child_table");
  expect(child).toEqual({
    schema: "public",
    name: "composite_child_table",
    primaryKey: ["id"],
    columns: [
      {
        name: "id",
        type: "integer",
        udtName: "int4",
        nullable: false,
        numericPrecision: 32,
        numericScale: 0,
        sqlType: "integer",
      },
      {
        name: "parent_id",
        type: "integer",
        udtName: "int4",
        nullable: false,
        numericPrecision: 32,
        numericScale: 0,
        sqlType: "integer",
      },
      {
        name: "tenant_id",
        type: "integer",
        udtName: "int4",
        nullable: false,
        numericPrecision: 32,
        numericScale: 0,
        sqlType: "integer",
      },
      {
        name: "sku",
        type: "text",
        udtName: "text",
        nullable: false,
        sqlType: "text",
      },
    ],
    foreignKeys: [
      {
        constraintName: "composite_child_table_parent_id_tenant_id_fkey",
        fromTable: "public.composite_child_table",
        fromColumns: ["parent_id", "tenant_id"],
        toTable: "public.composite_parent_table",
        toColumns: ["id", "tenant_id"],
      },
    ],
  });
  expect(
    schema.tables.find((t) => t.name === "composite_parent_table")?.primaryKey,
  ).toEqual(["tenant_id", "id"]);
});

test("inspect reports enums, domains and sized types", async () => {
  const schema = await inspect(db.source.url);
  const columns = (table: string) =>
    schema.tables.find((t) => t.name === table)!.columns;

  expect(schema.enums).toEqual({ enum_status: ["active", "inactive"] });
  expect(columns("enum_table")[1]).toMatchObject({
    type: "USER-DEFINED",
    udtName: "enum_status",
    sqlType: "enum_status",
  });
  expect(columns("domain_table")[1]).toMatchObject({
    type: "USER-DEFINED",
    udtName: "positive_int",
    sqlType: "positive_int",
  });
  expect(columns("typed_table")).toMatchObject([
    { name: "id", type: "bigint" },
    { name: "at", type: "timestamp with time zone" },
    {
      name: "amount",
      type: "numeric",
      numericPrecision: 12,
      numericScale: 4,
      sqlType: "numeric(12,4)",
    },
    {
      name: "code",
      type: "character varying",
      charMaxLength: 8,
      sqlType: "character varying(8)",
    },
    { name: "payload", type: "jsonb" },
    { name: "tags", type: "ARRAY", udtName: "_text", sqlType: "text[]" },
    { name: "blob", type: "bytea" },
  ]);
});
