import { qualifiedName } from "./catalog.js";

/** One or more columns on a single table, paired by index with another ref's columns. */
export interface ColumnRef {
  schema: string;
  table: string;
  columns: string[];
}

/**
 * An application-level relationship, declared in the schema file. `at` is
 * where in the file it was declared, for error messages.
 */
export type Relation = (
  | { kind: "foreignKey"; from: ColumnRef; to: ColumnRef }
  | {
      kind: "polymorphic";
      from: ColumnRef;
      /** Discriminator column, on the same table as `from`. */
      typeColumn: ColumnRef;
      /** Discriminator value -> referenced column. */
      targets: Record<string, ColumnRef>;
    }
  | { kind: "ignore"; column: ColumnRef }
) & { at?: string };

/** One column of one table, e.g. a dependency break or an applied cycle break. */
export interface TableColumn {
  /** "schema.table" */
  table: string;
  column: string;
}

export type DependencyBreak = TableColumn & { at?: string };

/** Where a subset starts: the rows of `table` matching `where`, a raw SQL WHERE fragment. */
export interface Seed {
  /** "schema.table" */
  table: string;
  where: string;
}

/**
 * "downstream" (default): rows pulled in only as required parents aren't
 * used to fan back out to their other children. "full": every row fans out.
 */
export const TRAVERSALS = ["downstream", "full"] as const;
export type Traversal = (typeof TRAVERSALS)[number];

/** Every problem found in a schema file, reported together. */
export class ConfigError extends Error {
  constructor(
    readonly issues: string[],
    readonly file?: string,
  ) {
    super(
      `${file ? `${file}: ` : ""}invalid schema file:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

/** The NodeId ("schema.table") a reference points into. */
export function tableKey(t: { schema: string; table: string }): string {
  return qualifiedName(t.schema, t.table);
}

export function formatRef(r: ColumnRef): string {
  return r.columns.length === 1
    ? `${tableKey(r)}.${r.columns[0]}`
    : `${tableKey(r)}.[${r.columns.join(",")}]`;
}

/** Qualifies a bare table name with the "public" schema. */
export function qualifyTable(table: string): string {
  return table.includes(".") ? table : `public.${table}`;
}
