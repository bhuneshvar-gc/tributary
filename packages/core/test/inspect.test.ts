import { expect, test } from "vitest";
import { inspect } from "../src/index.js";
import { useDatabases } from "./support/engine.js";

const db = useDatabases();

const int = (name: string) => ({
  name,
  type: "integer",
  udtSchema: "pg_catalog",
  udtName: "int4",
  sqlType: "integer",
  nullable: false,
});

test("inspect reports base tables with columns, keys and composite foreign keys", async () => {
  const schema = await inspect(db.source.url);

  expect(schema.tables.map((t) => t.name)).not.toContain("leaf_view");
  const child = schema.tables.find((t) => t.name === "composite_child_table");
  expect(child).toEqual({
    schema: "public",
    name: "composite_child_table",
    primaryKey: ["id"],
    columns: [
      int("id"),
      int("parent_id"),
      int("tenant_id"),
      {
        name: "sku",
        type: "text",
        udtSchema: "pg_catalog",
        udtName: "text",
        sqlType: "text",
        nullable: false,
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
  expect(schema.tables.find((t) => t.name === "composite_parent_table")?.primaryKey).toEqual([
    "tenant_id",
    "id",
  ]);
});

test("inspect reports schema-qualified enums, domains and exact types", async () => {
  const schema = await inspect(db.source.url);
  const columns = (table: string) => schema.tables.find((t) => t.name === table)!.columns;

  expect(schema.enums).toEqual({
    "billing.invoice_status": ["draft", "paid"],
    "public.enum_status": ["active", "inactive"],
    "public.invoice_status": ["open", "closed"],
    "public.mood": ["happy", "sad"],
  });
  expect(columns("enum_table")[1]).toMatchObject({
    type: "USER-DEFINED",
    udtSchema: "public",
    udtName: "enum_status",
    sqlType: "enum_status",
  });
  expect(columns("invoice")).toMatchObject([
    { name: "id" },
    {
      name: "status",
      udtSchema: "billing",
      udtName: "invoice_status",
      sqlType: "billing.invoice_status",
    },
    { name: "legacy", udtSchema: "public", udtName: "invoice_status", sqlType: "invoice_status" },
    {
      name: "history",
      type: "ARRAY",
      udtSchema: "billing",
      udtName: "_invoice_status",
      sqlType: "billing.invoice_status[]",
    },
  ]);
  expect(columns("domain_table")[1]).toMatchObject({
    type: "USER-DEFINED",
    udtSchema: "public",
    udtName: "positive_int",
    sqlType: "positive_int",
  });
  expect(columns("typed_table").map((c) => [c.name, c.sqlType])).toEqual([
    ["id", "bigint"],
    ["at", "timestamp with time zone"],
    ["amount", "numeric(12,4)"],
    ["code", "character varying(8)"],
    ["payload", "jsonb"],
    ["tags", "text[]"],
    ["blob", "bytea"],
  ]);
});
