import { describe, expect, test } from "vitest";
import { parseSchemaFile, schemaTemplate } from "../src/index.js";
import { fk, schema, table } from "./support/schema.js";

const db = schema(
  table("public.customers", ["id"]),
  table("public.order_management_v2_orders", ["id", "customer_id", "carrier_id"], {
    fks: [fk("orders_customer_fk", ["customer_id"], "public.customers")],
  }),
  table("public.order_management_v2_order_line_items", ["id", "order_id", "category_id"]),
  table("public.categories", ["id", "parent_id"]),
  table("public.product_categories", ["id"]),
  table("billing.invoices", ["id", "customer_id"]),
);

describe("schemaTemplate (yaml)", () => {
  const { text, tables, candidates } = schemaTemplate(db);

  test("is a valid schema file that declares nothing until you uncomment", () => {
    expect(parseSchemaFile(text)).toMatchObject({ relations: [], cycleBreaks: [] });
    expect(text).toMatch(/^version: 1\ndefaultSchema: public\ntables:\n/m);
  });

  test("lists every table, sorted and always schema-qualified, public included", () => {
    expect([...text.matchAll(/^ {2}(\S+):$/gm)].map((m) => m[1])).toEqual([
      "billing.invoices",
      "public.categories",
      "public.customers",
      "public.order_management_v2_order_line_items",
      "public.order_management_v2_orders",
      "public.product_categories",
    ]);
    expect(tables).toBe(6);
  });

  test("real foreign keys are shown as comments with qualified targets, never as guesses", () => {
    expect(text).toContain(
      "# customer_id -> public.customers.id  (database foreign key, followed already)",
    );
    const orders = text.split("\n  public.order_management_v2_orders:\n")[1]!.split(/\n {2}\S/)[0]!;
    expect(orders).not.toContain("# customer_id:");
  });

  test("an *_id column without a foreign key is listed bare for you to fill in, with no guessed target", () => {
    const items = text
      .split("\n  public.order_management_v2_order_line_items:\n")[1]!
      .split(/\n {2}\S/)[0]!;
    expect(items).toBe("    references:\n      # order_id:\n      # category_id:");
    expect(text).not.toContain("guess");
    expect(text).not.toMatch(/# \w+_id: \S/);
  });

  test("counts the columns left to fill in", () => {
    // invoices.customer_id, orders.carrier_id, line_items.order_id + category_id, categories.parent_id
    expect(candidates).toBe(5);
  });

  test("uncommenting a listed column and filling in its target makes a reference", () => {
    const filled = text.replace("# order_id:", "order_id: public.order_management_v2_orders.id");
    expect(parseSchemaFile(filled).relations).toMatchObject([
      {
        from: {
          schema: "public",
          table: "order_management_v2_order_line_items",
          columns: ["order_id"],
        },
        to: { schema: "public", table: "order_management_v2_orders", columns: ["id"] },
      },
    ]);
  });
});

test("schemaTemplate (json) is valid JSON listing every qualified table", () => {
  const { text, tables } = schemaTemplate(db, { format: "json" });
  const data = JSON.parse(text);
  expect(Object.keys(data.tables)).toHaveLength(tables);
  expect(data).toMatchObject({
    version: 1,
    defaultSchema: "public",
    tables: { "billing.invoices": {}, "public.customers": {} },
  });
  expect(parseSchemaFile(data)).toMatchObject({ relations: [], cycleBreaks: [] });
});
