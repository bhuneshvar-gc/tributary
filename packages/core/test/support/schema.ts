import type { Column, ForeignKey, Schema, Table } from "../../src/index.js";

/** Builds a catalog Table fixture: `table("public.orders", ["id", "user_id"], { fks: ... })`. */
export function table(
  id: string,
  columns: (string | (Partial<Column> & { name: string }))[],
  opts: { pk?: string[]; fks?: Omit<ForeignKey, "fromTable">[] } = {},
): Table {
  const [schema, name] = id.split(".") as [string, string];
  return {
    schema,
    name,
    columns: columns.map((c) =>
      typeof c === "string"
        ? {
            name: c,
            type: "integer",
            nullable: true,
            udtSchema: "pg_catalog",
            udtName: "int4",
            sqlType: "integer",
          }
        : {
            type: "integer",
            nullable: true,
            udtSchema: "pg_catalog",
            udtName: "int4",
            sqlType: "integer",
            ...c,
          },
    ),
    primaryKey: opts.pk ?? ["id"],
    foreignKeys: (opts.fks ?? []).map((fk) => ({ ...fk, fromTable: id })),
  };
}

export function schema(...tables: Table[]): Schema {
  return { tables, enums: {} };
}

export function fk(
  constraintName: string,
  fromColumns: string[],
  toTable: string,
  toColumns: string[] = ["id"],
): Omit<ForeignKey, "fromTable"> {
  return { constraintName, fromColumns, toTable, toColumns };
}
