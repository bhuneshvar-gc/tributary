import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
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

/** The template with every guessed reference uncommented. */
function accepted(text: string): string {
  return text.replace(/^(\s*)# (\S+: \S+)\s+# guessed.*$/gm, "$1$2");
}

describe("schemaTemplate (yaml)", () => {
  const { text, tables, suggestions } = schemaTemplate(db);

  test("is a valid schema file that declares nothing until you uncomment", () => {
    expect(parseSchemaFile(parseYaml(text))).toEqual({ relations: [], dependencyBreaks: [] });
    expect(text).toMatch(/^version: 1\ndefaultSchema: public\ntables:\n/m);
  });

  test("lists every table, sorted: bare names in the default schema, qualified otherwise", () => {
    expect([...text.matchAll(/^ {2}(\S+):$/gm)].map((m) => m[1])).toEqual([
      "billing.invoices",
      "categories",
      "customers",
      "order_management_v2_order_line_items",
      "order_management_v2_orders",
      "product_categories",
    ]);
    expect(tables).toBe(6);
    expect(text).toContain("\n  customers:\n");
    expect(text).toContain("\n  order_management_v2_orders:\n");
    expect(text).toContain("\n  billing.invoices:\n");
  });

  test("real foreign keys are shown as comments, never as guesses", () => {
    expect(text).toContain(
      "# customer_id -> customers.id  (database foreign key, followed already)",
    );
    const orders = text.split("\n  order_management_v2_orders:\n")[1]!.split(/\n {2}\S/)[0]!;
    expect(orders).not.toContain("# customer_id:");
  });

  test("an *_id column without a foreign key gets a commented guess, prefixes and plurals included", () => {
    expect(text).toMatch(
      /# order_id: order_management_v2_orders\.id\s+# guessed from the column name/,
    );
    expect(text).toMatch(/# customer_id: customers\.id\s+# guessed/); // billing.invoices, across schemas
  });

  test("an ambiguous guess names the alternatives, and no match leaves a placeholder", () => {
    expect(text).toMatch(
      /# category_id: categories\.id\s+# guessed .*also: product_categories\.id/,
    );
    expect(text).toContain('# carrier_id:   # no table matches "carrier"; fill in "table.column"');
    expect(suggestions).toBe(3);
  });

  test("uncommented guesses become references", () => {
    expect(parseSchemaFile(parseYaml(accepted(text))).relations).toMatchObject([
      {
        from: { schema: "billing", table: "invoices", columns: ["customer_id"] },
        to: { schema: "public", table: "customers", columns: ["id"] },
      },
      {
        from: { table: "order_management_v2_order_line_items", columns: ["order_id"] },
        to: { table: "order_management_v2_orders", columns: ["id"] },
      },
      {
        from: { table: "order_management_v2_order_line_items", columns: ["category_id"] },
        to: { table: "categories", columns: ["id"] },
      },
    ]);
  });
});

test("schemaTemplate (json) is valid JSON listing every table, with no guesses", () => {
  const { text, tables } = schemaTemplate(db, { format: "json" });
  const data = JSON.parse(text);
  expect(Object.keys(data.tables)).toHaveLength(tables);
  expect(data).toMatchObject({
    version: 1,
    defaultSchema: "public",
    tables: { "billing.invoices": {} },
  });
  expect(parseSchemaFile(data)).toEqual({ relations: [], dependencyBreaks: [] });
});
