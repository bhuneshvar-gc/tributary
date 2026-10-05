import type { Column, Schema, Table } from "@bhuneshvar-k/tributary-core";
import { describe, expect, test } from "vitest";
import { schemaTools } from "../src/schema-tools.js";

const col = (name: string, sqlType = "uuid"): Column => ({
  name,
  type: sqlType,
  nullable: true,
  udtSchema: "pg_catalog",
  udtName: sqlType,
  sqlType,
});

function table(schema: string, name: string, columns: string[], extra: Partial<Table> = {}): Table {
  return {
    schema,
    name,
    columns: columns.map((c) => col(c)),
    primaryKey: ["id"],
    foreignKeys: [],
    ...extra,
  };
}

const orders = ["id", "client_group_id", "created_by_user_id", "reference_number"];
const catalog: Schema = {
  enums: {},
  tables: [
    table("public", "users", ["id", "email", "company_id"], {
      foreignKeys: [
        {
          constraintName: "users_company_fk",
          fromTable: "public.users",
          fromColumns: ["company_id"],
          toTable: "public.companies",
          toColumns: ["id"],
        },
      ],
    }),
    table("public", "companies", ["id", "name"]),
    table("unilever", "order_management_v2_orders", orders),
    table("agratas", "order_management_v2_orders", orders),
    table("unilever", "order_management_v2_order_line_items", ["id", "order_id", "product_code"]),
    table("agratas", "order_management_v2_order_line_items", ["id", "order_id", "product_code"]),
    table("mdemo", "order_management_v2_orders", [...orders, "legacy_flag"]),
  ],
};

const tools = schemaTools(catalog);

describe("listSchemas", () => {
  test("lists every schema with its table count", () => {
    expect(tools.listSchemas()).toEqual([
      { schema: "agratas", tables: 2 },
      { schema: "mdemo", tables: 1 },
      { schema: "public", tables: 2 },
      { schema: "unilever", tables: 2 },
    ]);
  });
});

describe("searchTables", () => {
  test("identical tenant copies collapse into one result naming their schemas", () => {
    expect(tools.searchTables("line items")).toEqual([
      {
        table: "order_management_v2_order_line_items",
        schemas: ["agratas", "unilever"],
        matchingColumns: [],
      },
    ]);
  });

  test("a copy whose columns differ is its own result", () => {
    const results = tools.searchTables("orders");
    expect(results.filter((r) => r.table === "order_management_v2_orders")).toEqual([
      {
        table: "order_management_v2_orders",
        schemas: ["agratas", "unilever"],
        matchingColumns: [],
      },
      { table: "order_management_v2_orders", schemas: ["mdemo"], matchingColumns: [] },
    ]);
  });

  test("matches column names too, ranking table-name matches first", () => {
    const results = tools.searchTables("user email");
    expect(results[0]).toEqual({ table: "users", schemas: ["public"], matchingColumns: ["email"] });
    expect(results.map((r) => r.table)).toContain("order_management_v2_orders"); // created_by_user_id
  });

  test("plural and singular words match alike, case-insensitively", () => {
    expect(tools.searchTables("Companies")[0]?.table).toBe("companies");
    expect(tools.searchTables("company")[0]?.table).toBe("companies");
  });

  test("returns at most 15 results", () => {
    const many: Schema = {
      enums: {},
      tables: Array.from({ length: 40 }, (_, i) => table("public", `orders_${i}`, ["id"])),
    };
    expect(schemaTools(many).searchTables("orders")).toHaveLength(15);
  });
});

describe("describeTable", () => {
  test("describes a qualified table: key, columns and references", () => {
    expect(tools.describeTable("public.users")).toEqual({
      table: "public.users",
      alsoIn: [],
      primaryKey: ["id"],
      columns: [
        { name: "id", type: "uuid", nullable: true },
        { name: "email", type: "uuid", nullable: true },
        { name: "company_id", type: "uuid", nullable: true },
      ],
      references: ["company_id -> public.companies.id"],
    });
  });

  test("a bare name describes one copy and lists the other schemas with the same table", () => {
    expect(tools.describeTable("order_management_v2_order_line_items")).toMatchObject({
      table: "agratas.order_management_v2_order_line_items",
      alsoIn: ["unilever"],
    });
  });

  test("an unknown table says how to find it", () => {
    expect(tools.describeTable("nope")).toEqual({
      error: 'no table named "nope"; use search_tables to find it',
    });
  });
});
