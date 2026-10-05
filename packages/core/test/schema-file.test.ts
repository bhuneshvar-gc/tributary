import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadSchemaFile, parseSchemaFile, SchemaFileError } from "../src/index.js";

const ref = (schema: string, table: string, ...columns: string[]) => ({ schema, table, columns });

function issues(input: unknown): string[] {
  try {
    parseSchemaFile(input);
  } catch (e) {
    if (e instanceof SchemaFileError) return e.issues;
    throw e;
  }
  throw new Error("expected a SchemaFileError");
}

describe("parseSchemaFile", () => {
  test("a reference maps a column to the column it points at, in the default schema", () => {
    const schema = parseSchemaFile({
      version: 1,
      tables: { order_line_items: { references: { order_id: "orders.id" } } },
    });
    expect(schema.relations).toEqual([
      {
        kind: "foreignKey",
        from: ref("public", "order_line_items", "order_id"),
        to: ref("public", "orders", "id"),
        at: "tables.order_line_items.references.order_id",
      },
    ]);
  });

  test("defaultSchema applies to bare names; qualified names keep their schema", () => {
    const schema = parseSchemaFile({
      version: 1,
      defaultSchema: "app",
      tables: {
        invoices: { references: { customer_id: "crm.customers.id" } },
        "billing.payments": { references: { invoice_id: "invoices.id" } },
      },
    });
    expect(schema.relations).toMatchObject([
      {
        kind: "foreignKey",
        from: ref("app", "invoices", "customer_id"),
        to: ref("crm", "customers", "id"),
      },
      {
        kind: "foreignKey",
        from: ref("billing", "payments", "invoice_id"),
        to: ref("app", "invoices", "id"),
      },
    ]);
  });

  test("a composite reference is a comma-joined key paired in order with its targets", () => {
    const schema = parseSchemaFile({
      version: 1,
      tables: {
        line_items: { references: { "tenant_id, order_id": ["orders.tenant_id", "orders.id"] } },
      },
    });
    expect(schema.relations).toMatchObject([
      {
        kind: "foreignKey",
        from: ref("public", "line_items", "tenant_id", "order_id"),
        to: ref("public", "orders", "tenant_id", "id"),
      },
    ]);
  });

  test("a polymorphic column resolves its discriminator and each target", () => {
    const schema = parseSchemaFile({
      version: 1,
      tables: {
        comments: {
          polymorphic: {
            subject_id: {
              typeColumn: "subject_type",
              targets: { Post: "posts.id", Photo: "media.photos.id" },
            },
          },
        },
      },
    });
    expect(schema.relations).toMatchObject([
      {
        kind: "polymorphic",
        from: ref("public", "comments", "subject_id"),
        typeColumn: ref("public", "comments", "subject_type"),
        targets: { Post: ref("public", "posts", "id"), Photo: ref("media", "photos", "id") },
      },
    ]);
  });

  test("ignore and breakCycle name columns of the table they're under", () => {
    const schema = parseSchemaFile({
      version: 1,
      tables: {
        audit_logs: { ignore: ["actor_id"] },
        "hr.employees": { breakCycle: ["manager_id"] },
      },
    });
    expect(schema.relations).toMatchObject([
      { kind: "ignore", column: ref("public", "audit_logs", "actor_id") },
    ]);
    expect(schema.cycleBreaks).toMatchObject([{ table: "hr.employees", column: "manager_id" }]);
  });

  test("tables and sections left empty (only comments in YAML) are fine", () => {
    expect(
      parseSchemaFile({ version: 1, tables: { containers: null, orders: { references: null } } }),
    ).toMatchObject({ relations: [], cycleBreaks: [] });
  });

  test("records the default schema and every declared table, even empty ones", () => {
    expect(
      parseSchemaFile({
        version: 1,
        defaultSchema: "app",
        tables: { containers: null, "crm.leads": {} },
      }),
    ).toMatchObject({
      defaultSchema: "app",
      tables: [
        { table: "app.containers", at: "tables.containers" },
        { table: "crm.leads", at: 'tables."crm.leads"' },
      ],
    });
  });

  test("accepts YAML or JSON text as well as a parsed object", () => {
    const yaml = "version: 1\ntables:\n  a:\n    references:\n      b_id: b.id\n";
    expect(parseSchemaFile(yaml).relations).toHaveLength(1);
    expect(
      parseSchemaFile('{"version": 1, "tables": {"a": {"ignore": ["x"]}}}').relations,
    ).toHaveLength(1);
  });

  describe("identification", () => {
    test("a file without version: 1 isn't a tributary schema file", () => {
      expect(issues({ openapi: "3.0.0" })).toEqual([
        "not a tributary schema file: it needs `version: 1` at the top",
      ]);
    });

    test("an unknown version is rejected", () => {
      expect(issues({ version: 2, tables: {} })).toEqual([
        "unsupported schema file version 2 (this tributary reads version 1)",
      ]);
    });
  });

  describe("validation", () => {
    test("a composite key and its targets must have the same number of columns", () => {
      expect(
        issues({
          version: 1,
          tables: { line_items: { references: { "tenant_id, order_id": "orders.id" } } },
        }),
      ).toEqual([
        'tables.line_items.references."tenant_id, order_id": 2 columns but 1 target column',
      ]);
    });

    test("composite targets must all be on one table", () => {
      expect(
        issues({
          version: 1,
          tables: { line_items: { references: { "a, b": ["orders.a", "carts.b"] } } },
        }),
      ).toEqual([
        'tables.line_items.references."a, b": targets must all be on one table, got public.orders and public.carts',
      ]);
    });

    test("a malformed target is named with its location", () => {
      expect(
        issues({ version: 1, tables: { line_items: { references: { order_id: "orders" } } } }),
      ).toEqual([
        'tables.line_items.references.order_id: invalid target "orders": expected "table.column" or "schema.table.column"',
      ]);
    });

    test("a column can't reference itself", () => {
      expect(issues({ version: 1, tables: { nodes: { references: { id: "nodes.id" } } } })).toEqual(
        ["tables.nodes.references.id: a column can't reference itself"],
      );
    });

    test("unknown keys are rejected", () => {
      expect(issues({ version: 1, tables: { orders: { refs: {} } } })).toEqual([
        'tables.orders: Unrecognized key: "refs"',
      ]);
    });

    test("every problem is reported at once", () => {
      expect(
        issues({
          version: 1,
          tables: {
            a: { references: { x: "bad" } },
            b: { polymorphic: { y: { typeColumn: "t", targets: {} } } },
            c: { breakCycle: [""] },
          },
        }),
      ).toHaveLength(3);
    });

    test("a structural problem doesn't hide problems in other sections or tables", () => {
      expect(
        issues({
          version: 1,
          tables: {
            a: { references: { x: "bad" }, ignore: "not-a-list" },
            b: { refs: {} },
            c: { references: { y: "also_bad" } },
          },
        }),
      ).toEqual([
        "tables.a.ignore: Invalid input: expected array, received string",
        'tables.a.references.x: invalid target "bad": expected "table.column" or "schema.table.column"',
        'tables.b: Unrecognized key: "refs"',
        'tables.c.references.y: invalid target "also_bad": expected "table.column" or "schema.table.column"',
      ]);
    });

    test("a polymorphic entry is a single column, not a comma list", () => {
      expect(
        issues({
          version: 1,
          tables: { c: { polymorphic: { "a, b": { typeColumn: "t", targets: { X: "x.id" } } } } },
        }),
      ).toEqual(['tables.c.polymorphic."a, b": a polymorphic reference is one column, not a list']);
    });
  });
});

describe("loadSchemaFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "tributary-schema-"));

  test("reads YAML", async () => {
    const path = join(dir, "schema.yaml");
    writeFileSync(
      path,
      [
        "version: 1",
        "tables:",
        "  line_items:",
        "    references:",
        "      order_id: orders.id",
        '      "tenant_id, cart_id": [carts.tenant_id, carts.id]',
        "  containers:",
        "    # nothing yet",
      ].join("\n"),
    );
    expect((await loadSchemaFile(path)).relations).toHaveLength(2);
  });

  test("reads JSON", async () => {
    const path = join(dir, "schema.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, tables: { a: { references: { b_id: "b.id" } } } }),
    );
    expect((await loadSchemaFile(path)).relations).toHaveLength(1);
  });

  test("problems name the file", async () => {
    const path = join(dir, "other.yaml");
    writeFileSync(path, "openapi: 3.0.0\n");
    await expect(loadSchemaFile(path)).rejects.toThrow(
      /other\.yaml: .*not a tributary schema file: it needs `version: 1`/s,
    );
  });

  test("unparseable YAML is reported with the file", async () => {
    const path = join(dir, "broken.yaml");
    writeFileSync(path, "version: 1\ntables: [unclosed\n");
    await expect(loadSchemaFile(path)).rejects.toThrow(/broken\.yaml: /);
  });
});
