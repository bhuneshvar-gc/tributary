import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { NodeId } from "./graph.js";
import {
  type ColumnRef,
  type CycleBreak,
  parseTableName,
  type Relation,
  SchemaFileError,
  tableKey,
} from "./model.js";

/**
 * A parsed schema file: the facts about a database's structure that its
 * catalog can't tell Tributary. Run options (seeds, connections,
 * traversal) never live here.
 */
export interface SchemaFile {
  /** Schema that bare table names resolve to, in the file and for seeds. */
  defaultSchema: string;
  /** Every table the file names, including ones with nothing declared yet. */
  tables: { table: NodeId; at: string }[];
  relations: Relation[];
  cycleBreaks: CycleBreak[];
}

export function emptySchemaFile(): SchemaFile {
  return { defaultSchema: "public", tables: [], relations: [], cycleBreaks: [] };
}

/**
 * One table entry's sections. Each is checked on its own, so one
 * malformed section doesn't hide problems elsewhere; their meaning
 * (targets resolving, column counts matching) is checked afterwards.
 * Every section may be null: a YAML key followed only by comments.
 */
const sections = {
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
};
type Sections = { [K in keyof typeof sections]?: z.output<(typeof sections)[K]> };

function pathKey(key: string): string {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}

function zodIssues(at: string, error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = [at, ...i.path.map((p) => pathKey(String(p)))].filter(Boolean).join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}

/**
 * Validates and normalizes a schema file: YAML or JSON text, or contents
 * already parsed into an object. Every problem is reported at once in one
 * SchemaFileError.
 */
export function parseSchemaFile(input: unknown): SchemaFile {
  const data = typeof input === "string" ? parseText(input) : input;
  if (typeof data !== "object" || data === null || !("version" in data)) {
    throw new SchemaFileError(["not a tributary schema file: it needs `version: 1` at the top"]);
  }
  if (data.version !== 1) {
    throw new SchemaFileError([
      `unsupported schema file version ${JSON.stringify(data.version)} (this tributary reads version 1)`,
    ]);
  }

  const issues: string[] = [];
  const top = z
    .object({
      version: z.literal(1),
      defaultSchema: z.string().min(1).default("public"),
      tables: z.record(z.string(), z.unknown()).nullish(),
    })
    .strict()
    .safeParse(data);
  if (!top.success) throw new SchemaFileError(zodIssues("", top.error));

  const file: SchemaFile = { ...emptySchemaFile(), defaultSchema: top.data.defaultSchema };
  for (const [name, entry] of Object.entries(top.data.tables ?? {})) {
    const at = `tables.${pathKey(name)}`;
    const table = parseTableName(name, file.defaultSchema);
    if (!table) {
      issues.push(`${at}: invalid table name: expected "table" or "schema.table"`);
      continue;
    }
    file.tables.push({ table: tableKey(table), at });
    resolveTable(file, table, at, checkSections(entry, at, issues), issues);
  }
  if (issues.length) throw new SchemaFileError(issues);
  return file;
}

/** YAML is a superset of JSON, so one parser reads both. */
function parseText(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (e) {
    throw new SchemaFileError([`not valid YAML or JSON: ${(e as Error).message}`]);
  }
}

/** The well-formed sections of one table entry; problems with the rest go to `issues`. */
function checkSections(entry: unknown, at: string, issues: string[]): Sections {
  if (entry == null) return {};
  if (typeof entry !== "object" || Array.isArray(entry)) {
    issues.push(`${at}: expected a mapping of references, polymorphic, ignore and breakCycle`);
    return {};
  }
  const out: Sections = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!(key in sections)) {
      issues.push(`${at}: Unrecognized key: "${key}"`);
      continue;
    }
    const name = key as keyof Sections;
    const result = sections[name].safeParse(value);
    if (result.success) (out as Record<string, unknown>)[name] = result.data;
    else issues.push(...zodIssues(`${at}.${name}`, result.error));
  }
  return out;
}

function resolveTable(
  file: SchemaFile,
  table: { schema: string; table: string },
  at: string,
  entry: Sections,
  issues: string[],
): void {
  const column = (name: string): ColumnRef => ({ ...table, columns: [name] });
  const targetsOf = (targets: string[], where: string) =>
    resolveTargets(targets, file.defaultSchema, where, issues);

  for (const [key, target] of Object.entries(entry.references ?? {})) {
    const where = `${at}.references.${pathKey(key)}`;
    const columns = key.split(",").map((c) => c.trim());
    if (columns.some((c) => !c)) {
      issues.push(`${where}: expected a column name, or column names separated by commas`);
      continue;
    }
    const targets = typeof target === "string" ? [target] : target;
    if (columns.length !== targets.length) {
      issues.push(
        `${where}: ${count(columns.length, "column")} but ${count(targets.length, "target column")}`,
      );
      continue;
    }
    const to = targetsOf(targets, where);
    if (!to) continue;
    const from: ColumnRef = { ...table, columns };
    if (tableKey(from) === tableKey(to) && from.columns.join() === to.columns.join()) {
      issues.push(`${where}: a column can't reference itself`);
      continue;
    }
    file.relations.push({ kind: "foreignKey", from, to, at: where });
  }

  for (const [key, poly] of Object.entries(entry.polymorphic ?? {})) {
    const where = `${at}.polymorphic.${pathKey(key)}`;
    if (key.includes(",")) {
      issues.push(`${where}: a polymorphic reference is one column, not a list`);
      continue;
    }
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
      const to = targetsOf([target], `${where}.targets.${pathKey(value)}`);
      if (to) targets[value] = to;
    }
    if (Object.keys(targets).length !== values.length) continue;
    file.relations.push({
      kind: "polymorphic",
      from: column(key),
      typeColumn: column(poly.typeColumn),
      targets,
      at: where,
    });
  }

  entry.ignore?.forEach((name, i) => {
    if (!name) issues.push(`${at}.ignore.${i}: expected a column name`);
    else file.relations.push({ kind: "ignore", column: column(name), at: `${at}.ignore.${i}` });
  });
  entry.breakCycle?.forEach((name, i) => {
    if (!name) issues.push(`${at}.breakCycle.${i}: expected a column name`);
    else
      file.cycleBreaks.push({ table: tableKey(table), column: name, at: `${at}.breakCycle.${i}` });
  });
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Several "table.column" targets, which must all be on one table. */
function resolveTargets(
  targets: string[],
  defaultSchema: string,
  where: string,
  issues: string[],
): ColumnRef | undefined {
  let ref: ColumnRef | undefined;
  for (const target of targets) {
    const dot = target.lastIndexOf(".");
    const table = dot > 0 ? parseTableName(target.slice(0, dot), defaultSchema) : undefined;
    const column = target.slice(dot + 1);
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

/** Reads and parses a schema file (.yaml, .yml or .json); problems name the file. */
export async function loadSchemaFile(path: string): Promise<SchemaFile> {
  const ext = extname(path).toLowerCase();
  if (![".yaml", ".yml", ".json"].includes(ext)) {
    throw new SchemaFileError(
      [`unsupported file type "${ext || "(none)"}": a schema file is .yaml, .yml or .json`],
      path,
    );
  }
  const text = await readFile(path, "utf8");
  try {
    return parseSchemaFile(text);
  } catch (e) {
    if (e instanceof SchemaFileError) throw e.inFile(path);
    throw e;
  }
}
