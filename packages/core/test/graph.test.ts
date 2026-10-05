import { describe, expect, test } from "vitest";
import { buildGraph, ConfigError, parseProjectConfig } from "../src/index.js";
import { fk, schema, table } from "./support/schema.js";

const users = table("public.users", ["id", "company_id"], {
  fks: [fk("users_company_fk", ["company_id"], "public.companies")],
});
const companies = table("public.companies", ["id"]);

describe("buildGraph", () => {
  test("catalog foreign keys become edges walkable in both directions", () => {
    const g = buildGraph(schema(users, companies));
    const expected = {
      kind: "fixed",
      source: "catalog",
      from: "public.users",
      fromColumns: ["company_id"],
      to: "public.companies",
      toColumns: ["id"],
      constraintName: "users_company_fk",
    };
    expect(g.outgoing("public.users")).toEqual([expected]);
    expect(g.incoming("public.companies")).toEqual([expected]);
    expect(g.outgoing("public.companies")).toEqual([]);
  });

  test("a declared relation adds a soft foreign key", () => {
    const orders = table("public.orders", ["id", "user_ref"]);
    const g = buildGraph(
      schema(users, companies, orders),
      parseProjectConfig({
        relations: [{ from: "orders.user_ref", to: "users.id" }],
      }),
    );
    expect(g.outgoing("public.orders")).toEqual([
      {
        kind: "fixed",
        source: "declared",
        from: "public.orders",
        fromColumns: ["user_ref"],
        to: "public.users",
        toColumns: ["id"],
      },
    ]);
    expect(g.incoming("public.users").map((e) => e.from)).toEqual([
      "public.orders",
    ]);
  });

  test("a polymorphic relation is indexed under each of its targets", () => {
    const comments = table("public.comments", [
      "id",
      "subject_id",
      "subject_type",
    ]);
    const posts = table("public.posts", ["id"]);
    const g = buildGraph(
      schema(comments, posts, users, companies),
      parseProjectConfig({
        relations: [
          {
            from: "comments.subject_id",
            polymorphicType: "comments.subject_type",
            targets: { Post: "posts.id", User: "users.id" },
          },
        ],
      }),
    );
    const [edge] = g.outgoing("public.comments");
    expect(edge).toEqual({
      kind: "polymorphic",
      source: "declared",
      from: "public.comments",
      fromColumns: ["subject_id"],
      typeColumn: "subject_type",
      targets: {
        Post: { to: "public.posts", toColumns: ["id"] },
        User: { to: "public.users", toColumns: ["id"] },
      },
    });
    expect(g.polymorphicIncoming("public.posts")).toEqual([
      { edge, typeValue: "Post" },
    ]);
    expect(g.polymorphicIncoming("public.users")).toEqual([
      { edge, typeValue: "User" },
    ]);
    expect(g.incoming("public.posts")).toEqual([]);
  });

  test("an ignore removes the catalog foreign key using that column", () => {
    const g = buildGraph(
      schema(users, companies),
      parseProjectConfig({ relations: [{ ignore: "users.company_id" }] }),
    );
    expect(g.outgoing("public.users")).toEqual([]);
    expect(g.incoming("public.companies")).toEqual([]);
    expect(g.ignored.map((e) => e.constraintName)).toEqual([
      "users_company_fk",
    ]);
  });

  test("an ignore matching no catalog foreign key is an error", () => {
    expect(() =>
      buildGraph(
        schema(users, companies),
        parseProjectConfig({ relations: [{ ignore: "users.id" }] }),
      ),
    ).toThrow(
      /relations\.0: ignore=public\.users\.id: no catalog foreign key on "public\.users" uses column "id"/,
    );
  });

  test("references to unknown tables and columns are all reported together", () => {
    let error: unknown;
    try {
      buildGraph(
        schema(users, companies),
        parseProjectConfig({
          relations: [
            { from: "orders.user_ref", to: "users.id" },
            { from: "users.nope", to: "companies.id" },
            {
              from: "users.company_id",
              polymorphicType: "users.kind",
              targets: { A: "companies.id" },
            },
          ],
        }),
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([
      'relations.0: from=public.orders.user_ref: no such table "public.orders" in source schema',
      'relations.1: from=public.users.nope: no such column "nope" on "public.users"',
      'relations.2: polymorphicType=public.users.kind: no such column "kind" on "public.users"',
    ]);
  });

  describe("cycles", () => {
    const employees = table("public.employees", ["id", "manager_id"], {
      fks: [fk("employees_manager_fk", ["manager_id"], "public.employees")],
    });
    const teams = table("public.teams", ["id", "lead_id"], {
      fks: [fk("teams_lead_fk", ["lead_id"], "public.members")],
    });
    const members = table("public.members", ["id", "team_id"], {
      fks: [fk("members_team_fk", ["team_id"], "public.teams")],
    });

    test("self-references and multi-table loops are in a cycle; plain FKs are not", () => {
      const g = buildGraph(schema(employees, teams, members, users, companies));
      const [selfRef] = g.outgoing("public.employees");
      const [lead] = g.outgoing("public.teams");
      const [plain] = g.outgoing("public.users");
      expect(g.inCycle(selfRef!)).toBe(true);
      expect(g.inCycle(lead!)).toBe(true);
      expect(g.inCycle(plain!)).toBe(false);
    });

    test("a dependency break must name an edge that is in a cycle", () => {
      const tables = schema(employees, users, companies);
      expect(() =>
        buildGraph(
          tables,
          parseProjectConfig({
            dependencyBreaks: [{ table: "employees", column: "manager_id" }],
          }),
        ),
      ).not.toThrow();
      expect(() =>
        buildGraph(
          tables,
          parseProjectConfig({
            dependencyBreaks: [{ table: "users", column: "company_id" }],
          }),
        ),
      ).toThrow(
        /dependencyBreaks\.0: public\.users\.company_id is not part of any foreign key cycle/,
      );
    });
  });
});
