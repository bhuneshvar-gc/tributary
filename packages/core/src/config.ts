import { z } from "zod";
import { qualifiedName } from "./catalog.js";

/**
 * One or more columns on a single table. Written in config as
 * "table.column" / "schema.table.column", or a list of those sharing a
 * table (composite keys). An unqualified table defaults to "public".
 */
export interface ColumnRef {
  schema: string;
  table: string;
  columns: string[];
}

export type Relation =
  | { kind: "foreignKey"; from: ColumnRef; to: ColumnRef }
  | {
      kind: "polymorphic";
      from: ColumnRef;
      /** Discriminator column, on the same table as `from`. */
      typeColumn: ColumnRef;
      /** Discriminator value -> referenced column. */
      targets: Record<string, ColumnRef>;
    }
  | { kind: "ignore"; column: ColumnRef };

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid tributary config:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function parseColumnPath(s: string): {
  schema: string;
  table: string;
  column: string;
} {
  const parts = s.split(".");
  if (parts.length === 2) return { schema: "public", table: parts[0]!, column: parts[1]! };
  if (parts.length === 3) return { schema: parts[0]!, table: parts[1]!, column: parts[2]! };
  throw new Error(
    `invalid table.column reference "${s}": expected "table.column" or "schema.table.column"`,
  );
}

function toRef(raw: string | string[], ctx: z.RefinementCtx): ColumnRef {
  const list = typeof raw === "string" ? [raw] : raw;
  if (list.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "column reference list must not be empty",
    });
    return z.NEVER;
  }
  const columns: string[] = [];
  let first: { schema: string; table: string } | undefined;
  for (const s of list) {
    let parsed: ReturnType<typeof parseColumnPath>;
    try {
      parsed = parseColumnPath(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
    if (!first) first = parsed;
    else if (parsed.schema !== first.schema || parsed.table !== first.table) {
      ctx.addIssue({
        code: "custom",
        message: `composite reference must all reference the same table, got "${tableKey(first)}" and "${tableKey(parsed)}"`,
      });
      return z.NEVER;
    }
    columns.push(parsed.column);
  }
  return { schema: first!.schema, table: first!.table, columns };
}

const columnRef = z.union([z.string(), z.array(z.string())]).transform(toRef);

/** The NodeId ("schema.table") a reference points into. */
export function tableKey(t: { schema: string; table: string }): string {
  return qualifiedName(t.schema, t.table);
}

export function formatRef(r: ColumnRef): string {
  return r.columns.length === 1
    ? `${tableKey(r)}.${r.columns[0]}`
    : `${tableKey(r)}.[${r.columns.join(",")}]`;
}

const relationInput = z
  .object({
    from: columnRef.optional(),
    to: columnRef.optional(),
    polymorphicType: columnRef.optional(),
    targets: z.record(z.string(), columnRef).optional(),
    ignore: columnRef.optional(),
  })
  .strict();

/**
 * Classifies a relation into exactly one shape — a (possibly composite)
 * foreign key, a polymorphic association, or an ignore of a real catalog
 * FK — naming the incomplete or ambiguous combination of fields otherwise.
 */
function classifyRelation(r: z.output<typeof relationInput>, ctx: z.RefinementCtx): Relation {
  const fail = (message: string) => {
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  };
  const hasPoly = r.polymorphicType !== undefined || r.targets !== undefined;

  if (r.ignore) {
    if (hasPoly || r.from || r.to) {
      return fail(
        "relation must be exactly one of a foreign key, a polymorphic association, or an ignore, but 'ignore' is set alongside other fields",
      );
    }
    if (r.ignore.columns.length !== 1) return fail("ignore must name a single column");
    return { kind: "ignore", column: r.ignore };
  }

  if (hasPoly) {
    if (!r.from) return fail("polymorphic relation missing 'from'");
    const on = formatRef(r.from);
    if (!r.polymorphicType) return fail(`polymorphic relation on ${on} missing 'polymorphicType'`);
    if (!r.targets || Object.keys(r.targets).length === 0) {
      return fail(`polymorphic relation on ${on} missing 'targets'`);
    }
    if (r.to) return fail(`polymorphic relation on ${on} must not also set 'to'`);
    if (
      tableKey(r.polymorphicType) !== tableKey(r.from) ||
      r.polymorphicType.columns.length !== 1
    ) {
      return fail(
        `polymorphicType must be a single column on the same table as from (${tableKey(r.from)})`,
      );
    }
    for (const [value, target] of Object.entries(r.targets)) {
      if (target.columns.length !== r.from.columns.length) {
        return fail(`targets["${value}"]: column count must match from (${r.from.columns.length})`);
      }
    }
    return {
      kind: "polymorphic",
      from: r.from,
      typeColumn: r.polymorphicType,
      targets: r.targets,
    };
  }

  if (r.from && !r.to) return fail(`relation from=${formatRef(r.from)} missing 'to'`);
  if (!r.from && r.to) return fail(`relation to=${formatRef(r.to)} missing 'from'`);
  if (!r.from || !r.to) {
    return fail("relation has none of 'from'/'to', 'polymorphicType', or 'ignore' set");
  }
  if (r.from.columns.length !== r.to.columns.length) {
    return fail(
      `from=${formatRef(r.from)} to=${formatRef(r.to)}: composite key length mismatch (${r.from.columns.length} vs ${r.to.columns.length})`,
    );
  }
  if (formatRef(r.from) === formatRef(r.to)) {
    return fail(
      `from and to are identical (${formatRef(r.from)}); a relation can't reference itself`,
    );
  }
  return { kind: "foreignKey", from: r.from, to: r.to };
}

/** Qualifies a bare table name with the "public" schema. */
export function qualifyTable(table: string): string {
  return table.includes(".") ? table : `public.${table}`;
}

const qualifiedTable = z.string().min(1).transform(qualifyTable);

/**
 * "downstream" (default): rows pulled in only as required parents aren't
 * used to fan back out to their other children. "full": every row fans out.
 */
export const TRAVERSALS = ["downstream", "full"] as const;

/** One column of one table, e.g. a dependency break or an applied cycle break. */
export interface TableColumn {
  /** "schema.table" */
  table: string;
  column: string;
}

const projectConfigSchema = z
  .object({
    /** Name of a connection in the local user config. */
    source: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    /** Where the subset starts; the closure covers every seed's rows. */
    seeds: z
      .array(
        z
          .object({
            table: qualifiedTable,
            /** Raw SQL WHERE-clause fragment selecting the seed rows. */
            where: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    relations: z.array(relationInput.transform(classifyRelation)).default([]),
    /** FK columns to stop following (and defer on load) when they form a cycle. */
    dependencyBreaks: z
      .array(z.object({ table: qualifiedTable, column: z.string().min(1) }).strict())
      .default([]),
    /**
     * "downstream" (default): rows pulled in only as required parents aren't
     * used to fan back out to their other children. "full": every row fans out.
     */
    traversal: z.enum(TRAVERSALS).default("downstream"),
    /** Fail on a cycle with no dependency break instead of auto-breaking it. */
    strictCycles: z.boolean().default(false),
  })
  .strict();

export type ProjectConfigInput = z.input<typeof projectConfigSchema>;
export type ProjectConfig = z.output<typeof projectConfigSchema>;
export type Seed = ProjectConfig["seeds"][number];
export type DependencyBreak = TableColumn;
export type Traversal = ProjectConfig["traversal"];

/** Identity helper giving tributary.config.ts files type checking. */
export function defineConfig(config: ProjectConfigInput): ProjectConfigInput {
  return config;
}

/**
 * Validates and normalizes a project config (the object a
 * tributary.config.ts default-exports). Every problem in the input is
 * reported at once in a single ConfigError, not just the first.
 */
export function parseProjectConfig(input: unknown): ProjectConfig {
  const result = projectConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) =>
        i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
      ),
    );
  }
  return result.data;
}
