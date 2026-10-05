import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type ColumnRef,
  ConfigError,
  type DependencyBreak,
  type Relation,
  tableKey,
} from "./config.js";

/**
 * A parsed schema file: the facts about a database's structure that its
 * catalog can't tell Tributary. Run options (seeds, connections,
 * traversal) never live here.
 */
export interface SchemaFile {
  relations: Relation[];
  dependencyBreaks: DependencyBreak[];
}

export const EMPTY_SCHEMA_FILE: SchemaFile = { relations: [], dependencyBreaks: [] };

/**
 * The file's structure. Values are only typed here; their meaning
 * (references resolving, column counts matching) is checked afterwards by
 * hand so every problem in the file is reported together. Every section
 * may be null: a YAML key followed only by comments.
 */
const tableEntry = z
  .object({
    /** column (or "col_a, col_b") -> "table.column" (or a list, paired in order) */
    references: z.record(z.string(), z.union([z.string(), z.array(z.string())])).nullish(),
    /** column -> its discriminator column and discriminator value -> "table.column" */
    polymorphic: z
      .record(
        z.string(),
        z.object({ typeColumn: z.string(), targets: z.record(z.string(), z.string()) }).strict(),
      )
      .nullish(),
    /** real foreign key columns not to follow */
    ignore: z.array(z.string()).nullish(),
    /** foreign key columns that cut a cycle: not followed, loaded NULL, backfilled */
    breakCycle: z.array(z.string()).nullish(),
  })
  .strict()
  .nullish();

const fileStructure = z
  .object({
    version: z.literal(1),
    /** Schema for bare table names. */
    defaultSchema: z.string().min(1).default("public"),
    tables: z.record(z.string(), tableEntry).nullish(),
  })
  .strict();

type Structure = z.output<typeof fileStructure>;

function pathKey(key: string): string {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Validates and normalizes a schema file's contents (already parsed from
 * YAML or JSON). Every problem is reported at once in one ConfigError.
 */
export function parseSchemaFile(input: unknown): SchemaFile {
  if (typeof input !== "object" || input === null || !("version" in input)) {
    throw new ConfigError(["not a tributary schema file: it needs `version: 1` at the top"]);
  }
  if (input.version !== 1) {
    throw new ConfigError([
      `unsupported schema file version ${JSON.stringify(input.version)} (this tributary reads version 1)`,
    ]);
  }
  const result = fileStructure.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) =>
        i.path.length
          ? `${i.path.map((p) => pathKey(String(p))).join(".")}: ${i.message}`
          : i.message,
      ),
    );
  }
  const issues: string[] = [];
  const schema = resolve(result.data, issues);
  if (issues.length) throw new ConfigError(issues);
  return schema;
}

function resolve(file: Structure, issues: string[]): SchemaFile {
  const out: SchemaFile = { relations: [], dependencyBreaks: [] };
  const names = new Names(file.defaultSchema);

  for (const [tableName, entry] of Object.entries(file.tables ?? {})) {
    const at = `tables.${pathKey(tableName)}`;
    const table = names.table(tableName);
    if (!table) {
      issues.push(`${at}: invalid table name: expected "table" or "schema.table"`);
      continue;
    }
    const column = (name: string): ColumnRef => ({ ...table, columns: [name] });

    for (const [key, target] of Object.entries(entry?.references ?? {})) {
      const where = `${at}.references.${pathKey(key)}`;
      const columns = key.split(",").map((c) => c.trim());
      if (columns.some((c) => !c)) {
        issues.push(`${where}: expected a column name, or column names separated by commas`);
        continue;
      }
      const targets = typeof target === "string" ? [target] : target;
      if (columns.length !== targets.length) {
        issues.push(
          `${where}: ${columns.length} column${columns.length === 1 ? "" : "s"} but ${targets.length} target column${targets.length === 1 ? "" : "s"}`,
        );
        continue;
      }
      const to = names.columns(targets, where, issues);
      if (!to) continue;
      const from: ColumnRef = { ...table, columns };
      if (tableKey(from) === tableKey(to) && from.columns.join() === to.columns.join()) {
        issues.push(`${where}: a column can't reference itself`);
        continue;
      }
      out.relations.push({ kind: "foreignKey", from, to, at: where });
    }

    for (const [key, poly] of Object.entries(entry?.polymorphic ?? {})) {
      const where = `${at}.polymorphic.${pathKey(key)}`;
      if (!poly.typeColumn) {
        issues.push(`${where}.typeColumn: expected a column name`);
        continue;
      }
      const values = Object.entries(poly.targets);
      if (values.length === 0) {
        issues.push(`${where}.targets: needs at least one discriminator value -> "table.column"`);
        continue;
      }
      const targets: Record<string, ColumnRef> = {};
      for (const [value, target] of values) {
        const to = names.columns([target], `${where}.targets.${pathKey(value)}`, issues);
        if (to) targets[value] = to;
      }
      if (Object.keys(targets).length !== values.length) continue;
      out.relations.push({
        kind: "polymorphic",
        from: column(key),
        typeColumn: column(poly.typeColumn),
        targets,
        at: where,
      });
    }

    entry?.ignore?.forEach((name, i) => {
      if (!name) issues.push(`${at}.ignore.${i}: expected a column name`);
      else out.relations.push({ kind: "ignore", column: column(name), at: `${at}.ignore.${i}` });
    });
    entry?.breakCycle?.forEach((name, i) => {
      if (!name) issues.push(`${at}.breakCycle.${i}: expected a column name`);
      else
        out.dependencyBreaks.push({
          table: tableKey(table),
          column: name,
          at: `${at}.breakCycle.${i}`,
        });
    });
  }
  return out;
}

/** Resolves table and "table.column" names against the file's defaultSchema. */
class Names {
  constructor(private readonly defaultSchema: string) {}

  table(name: string): { schema: string; table: string } | undefined {
    const parts = name.split(".");
    if (parts.some((p) => !p)) return undefined;
    if (parts.length === 1) return { schema: this.defaultSchema, table: parts[0]! };
    if (parts.length === 2) return { schema: parts[0]!, table: parts[1]! };
    return undefined;
  }

  /** Several "table.column" targets that must all be on one table. */
  columns(targets: string[], where: string, issues: string[]): ColumnRef | undefined {
    let ref: ColumnRef | undefined;
    for (const target of targets) {
      const parts = target.split(".");
      const table =
        parts.length === 2 || parts.length === 3
          ? this.table(parts.slice(0, -1).join("."))
          : undefined;
      const column = parts.at(-1);
      if (!table || !column) {
        issues.push(
          `${where}: invalid target "${target}": expected "table.column" or "schema.table.column"`,
        );
        return undefined;
      }
      if (!ref) ref = { ...table, columns: [column] };
      else if (tableKey(ref) !== tableKey(table)) {
        issues.push(
          `${where}: targets must all be on one table, got ${tableKey(ref)} and ${tableKey(table)}`,
        );
        return undefined;
      } else ref.columns.push(column);
    }
    return ref;
  }
}

/** Reads and parses a schema file: .yaml/.yml as YAML, .json as JSON. */
export async function loadSchemaFile(path: string): Promise<SchemaFile> {
  const text = await readFile(path, "utf8");
  const ext = extname(path).toLowerCase();
  let data: unknown;
  try {
    if (ext === ".json") data = JSON.parse(text);
    else if (ext === ".yaml" || ext === ".yml") data = parseYaml(text);
    else throw new Error(`unsupported file type "${ext}": use .yaml, .yml or .json`);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`, { cause: e });
  }
  try {
    return parseSchemaFile(data);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(e.issues, path);
    throw e;
  }
}
