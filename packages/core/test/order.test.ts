import { describe, expect, test } from "vitest";
import { tableOrder } from "../src/index.js";
import { fk, schema, table } from "./support/schema.js";

const companies = table("public.companies", ["id"]);
const users = table("public.users", ["id", "company_id"], {
  fks: [fk("users_company_fk", ["company_id"], "public.companies")],
});
const orders = table("public.orders", ["id", "user_id"], {
  fks: [fk("orders_user_fk", ["user_id"], "public.users")],
});
const audit = table("public.audit", ["id"]);

describe("tableOrder", () => {
  test("parents load before children, ties broken alphabetically", () => {
    const s = schema(orders, users, companies, audit);
    expect(
      tableOrder(s, [
        "public.orders",
        "public.users",
        "public.companies",
        "public.audit",
      ]),
    ).toEqual([
      "public.audit",
      "public.companies",
      "public.users",
      "public.orders",
    ]);
  });

  test("a self-reference doesn't constrain ordering", () => {
    const employees = table("public.employees", ["id", "manager_id"], {
      fks: [fk("employees_manager_fk", ["manager_id"], "public.employees")],
    });
    expect(tableOrder(schema(employees), ["public.employees"])).toEqual([
      "public.employees",
    ]);
  });

  test("only constraints between the tables being loaded count", () => {
    expect(
      tableOrder(schema(orders, users, companies), [
        "public.orders",
        "public.users",
      ]),
    ).toEqual(["public.users", "public.orders"]);
  });

  describe("a multi-table cycle", () => {
    const teams = table("public.teams", ["id", "lead_id"], {
      fks: [fk("teams_lead_fk", ["lead_id"], "public.members")],
    });
    const members = table("public.members", ["id", "team_id"], {
      fks: [fk("members_team_fk", ["team_id"], "public.teams")],
    });
    const s = schema(teams, members);

    test("is an error naming the tables", () => {
      expect(() => tableOrder(s, ["public.teams", "public.members"])).toThrow(
        /cycle .*: public\.members, public\.teams/,
      );
    });

    test("orders once one of its columns is deferred", () => {
      const deferred = new Map([["public.teams", new Set(["lead_id"])]]);
      expect(
        tableOrder(s, ["public.teams", "public.members"], deferred),
      ).toEqual(["public.teams", "public.members"]);
    });
  });
});
