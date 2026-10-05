/**
 * One column of a table. `type` is information_schema's data_type;
 * custom types (enums, domains, composites) report "USER-DEFINED" with the
 * actual type name in `udtName`, and arrays report "ARRAY" with the
 * element type as `udtName` ("_int4" etc.).
 */
export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  udtName: string;
  /** The exact type as DDL would spell it (format_type), e.g. "numeric(12,4)". */
  sqlType: string;
  charMaxLength?: number;
  numericPrecision?: number;
  numericScale?: number;
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
  /** Enum type name -> labels in declaration order. */
  enums: Record<string, string[]>;
}

export function tableId(t: { schema: string; name: string }): string {
  return `${t.schema}.${t.name}`;
}
