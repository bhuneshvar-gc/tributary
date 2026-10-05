/**
 * One column of a table. `type` is information_schema's data_type;
 * custom types (enums, domains, composites) report "USER-DEFINED", and
 * arrays report "ARRAY" with the element type's name prefixed by "_".
 * `udtSchema`.`udtName` names the underlying type either way.
 */
export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  udtSchema: string;
  udtName: string;
  /** The exact type as DDL spells it (format_type), e.g. "numeric(12,4)", "billing.status[]". */
  sqlType: string;
}

/** A real foreign key constraint from pg_catalog. Columns pair by index. */
export interface ForeignKey {
  constraintName: string;
  /** "schema.table" */
  fromTable: string;
  fromColumns: string[];
  /** "schema.table" */
  toTable: string;
  toColumns: string[];
}

export interface Table {
  schema: string;
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
}

/**
 * The introspected shape of a database. Only half the picture: app-level
 * relationships pg_catalog can't see come from the project config's
 * `relations` and are merged in by buildGraph.
 */
export interface Schema {
  tables: Table[];
  /** "schema.type" -> labels in declaration order. */
  enums: Record<string, string[]>;
}

/** The "schema.name" identifier used for tables (NodeId) and types throughout. */
export function qualifiedName(schema: string, name: string): string {
  return `${schema}.${name}`;
}

export function tableId(t: Pick<Table, "schema" | "name">): string {
  return qualifiedName(t.schema, t.name);
}

export function findColumn(t: Pick<Table, "columns">, name: string): Column | undefined {
  return t.columns.find((c) => c.name === name);
}

/**
 * The custom type a column depends on, as "schema.type": its own type if
 * USER-DEFINED, or its element type if it's an array of a custom type.
 * Undefined for built-in types.
 */
export function customType(c: Column): string | undefined {
  if (c.type === "USER-DEFINED") return qualifiedName(c.udtSchema, c.udtName);
  if (c.type === "ARRAY" && c.udtSchema !== "pg_catalog") {
    return qualifiedName(c.udtSchema, c.udtName.replace(/^_/, ""));
  }
  return undefined;
}
