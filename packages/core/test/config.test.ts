import { describe, expect, test } from "vitest";
import { ConfigError, parseProjectConfig } from "../src/index.js";

describe("parseProjectConfig", () => {
  test("an unqualified relation reference defaults to the public schema", () => {
    const config = parseProjectConfig({
      relations: [{ from: "orders.user_ref", to: "users.id" }],
    });
    expect(config.relations).toEqual([
      {
        kind: "foreignKey",
        from: { schema: "public", table: "orders", columns: ["user_ref"] },
        to: { schema: "public", table: "users", columns: ["id"] },
      },
    ]);
  });

  test("a composite reference pairs columns on one table, qualified schema kept", () => {
    const config = parseProjectConfig({
      relations: [
        {
          from: ["billing.line.tenant_id", "billing.line.order_id"],
          to: ["orders.tenant_id", "orders.id"],
        },
      ],
    });
    expect(config.relations[0]).toEqual({
      kind: "foreignKey",
      from: {
        schema: "billing",
        table: "line",
        columns: ["tenant_id", "order_id"],
      },
      to: { schema: "public", table: "orders", columns: ["tenant_id", "id"] },
    });
  });

  test("rejects a composite reference spanning two tables", () => {
    expect(() =>
      parseProjectConfig({
        relations: [{ from: ["a.x", "b.y"], to: ["c.x", "c.y"] }],
      }),
    ).toThrow(/relations\.0\.from: .*same table/);
  });

  test("rejects a malformed reference", () => {
    expect(() =>
      parseProjectConfig({ relations: [{ from: "nodot", to: "users.id" }] }),
    ).toThrow(/relations\.0\.from: invalid table\.column reference "nodot"/);
  });

  test("rejects composite key length mismatch", () => {
    expect(() =>
      parseProjectConfig({ relations: [{ from: ["a.x", "a.y"], to: "b.id" }] }),
    ).toThrow(/relations\.0: .*composite key length mismatch \(2 vs 1\)/);
  });

  test("rejects a relation that references itself", () => {
    expect(() =>
      parseProjectConfig({ relations: [{ from: "a.id", to: "a.id" }] }),
    ).toThrow(/relations\.0: .*can't reference itself/);
  });

  test("a polymorphic relation resolves discriminator and targets", () => {
    const config = parseProjectConfig({
      relations: [
        {
          from: "comments.subject_id",
          polymorphicType: "comments.subject_type",
          targets: { Post: "posts.id", Photo: "media.photos.id" },
        },
      ],
    });
    expect(config.relations[0]).toEqual({
      kind: "polymorphic",
      from: { schema: "public", table: "comments", columns: ["subject_id"] },
      typeColumn: {
        schema: "public",
        table: "comments",
        columns: ["subject_type"],
      },
      targets: {
        Post: { schema: "public", table: "posts", columns: ["id"] },
        Photo: { schema: "media", table: "photos", columns: ["id"] },
      },
    });
  });

  test("rejects a polymorphic relation without targets", () => {
    expect(() =>
      parseProjectConfig({
        relations: [
          {
            from: "comments.subject_id",
            polymorphicType: "comments.subject_type",
          },
        ],
      }),
    ).toThrow(
      /relations\.0: polymorphic relation on public\.comments\.subject_id missing 'targets'/,
    );
  });

  test("an ignore suppresses one real catalog FK column", () => {
    const config = parseProjectConfig({
      relations: [{ ignore: "audit_logs.user_id" }],
    });
    expect(config.relations[0]).toEqual({
      kind: "ignore",
      column: { schema: "public", table: "audit_logs", columns: ["user_id"] },
    });
  });

  test("rejects an ignore combined with other relation fields", () => {
    expect(() =>
      parseProjectConfig({
        relations: [{ ignore: "a.b", from: "a.b", to: "c.d" }],
      }),
    ).toThrow(/relations\.0: .*exactly one of/);
  });

  test("rejects a relation with only one side of a foreign key", () => {
    expect(() => parseProjectConfig({ relations: [{ from: "a.b" }] })).toThrow(
      /relations\.0: relation from=public\.a\.b missing 'to'/,
    );
  });

  test("reports every problem in one error", () => {
    let error: unknown;
    try {
      parseProjectConfig({
        relations: [{ from: "a.b" }, { ignore: "bad" }],
        dependencyBreaks: [{ table: "employees" }],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toHaveLength(3);
  });

  test("dependency breaks default to the public schema", () => {
    const config = parseProjectConfig({
      dependencyBreaks: [
        { table: "employees", column: "manager_id" },
        { table: "hr.teams", column: "parent_id" },
      ],
    });
    expect(config.dependencyBreaks).toEqual([
      { table: "public.employees", column: "manager_id" },
      { table: "hr.teams", column: "parent_id" },
    ]);
  });

  test("applies defaults for an empty config", () => {
    expect(parseProjectConfig({})).toEqual({
      seeds: [],
      relations: [],
      dependencyBreaks: [],
      traversal: "downstream",
      strictCycles: false,
    });
  });

  test("keeps connection names and qualifies every seed", () => {
    const config = parseProjectConfig({
      source: "prod",
      target: "local",
      seeds: [
        { table: "users", where: "id = 42" },
        { table: "billing.invoices", where: "total > 100" },
      ],
    });
    expect(config).toMatchObject({
      source: "prod",
      target: "local",
      seeds: [
        { table: "public.users", where: "id = 42" },
        { table: "billing.invoices", where: "total > 100" },
      ],
    });
  });

  test("rejects unknown top-level keys", () => {
    expect(() => parseProjectConfig({ relatoins: [] })).toThrow(/relatoins/);
  });
});
