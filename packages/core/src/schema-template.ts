import { type Schema, type Table, tableId } from "./catalog.js";

export interface SchemaTemplate {
  text: string;
  /** Tables listed. */
  tables: number;
  /** Guessed references written as comments for review. */
  suggestions: number;
}

/** The schema bare names resolve to: public if it has tables, else the most common schema. */
function pickDefaultSchema(db: Schema): string {
  const counts = new Map<string, number>();
  for (const t of db.tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);
  if (counts.has("public") || counts.size === 0) return "public";
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

function plurals(word: string): string[] {
  const forms = [word, `${word}s`];
  if (/(s|x|z|ch|sh)$/.test(word)) forms.push(`${word}es`);
  if (/[^aeiou]y$/.test(word)) forms.push(`${word.slice(0, -1)}ies`);
  return forms;
}

/**
 * Tables an `<name>_id` column plausibly references, best first: a table
 * named after it (singular or plural) before one that merely ends with
 * it (`order_management_v2_orders` for `order_id`). Only tables with a
 * single-column primary key qualify, since that's what the guess points at.
 */
function candidates(db: Schema, base: string): Table[] {
  const forms = plurals(base);
  const keyed = db.tables.filter((t) => t.primaryKey.length === 1);
  const exact = keyed.filter((t) => forms.includes(t.name));
  const suffixed = keyed.filter(
    (t) => !exact.includes(t) && forms.some((f) => t.name.endsWith(`_${f}`)),
  );
  return [...exact, ...suffixed];
}

function yamlKey(name: string): string {
  return /^[\w.$-]+$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Writes a starting schema file for a database: every table, its real
 * foreign keys as comments (they're followed already), and, for each
 * `*_id` column with no foreign key, a commented guess at what it
 * references. Nothing guessed is active until the user uncomments it.
 * JSON can't hold comments, so a JSON template only lists the tables.
 */
export function schemaTemplate(
  db: Schema,
  options: { format?: "yaml" | "json" } = {},
): SchemaTemplate {
  const defaultSchema = pickDefaultSchema(db);
  const name = (t: Pick<Table, "schema" | "name">) =>
    t.schema === defaultSchema ? t.name : tableId(t);
  const target = (t: Table) => `${name(t)}.${t.primaryKey[0]}`;
  const nameOf = (id: string) => {
    const t = db.tables.find((x) => tableId(x) === id);
    return t ? name(t) : id;
  };

  const sorted = [...db.tables].sort((a, b) => tableId(a).localeCompare(tableId(b)));
  if (options.format === "json") {
    const tables = Object.fromEntries(sorted.map((t) => [name(t), {}]));
    return {
      text: `${JSON.stringify({ version: 1, defaultSchema, tables }, null, 2)}\n`,
      tables: db.tables.length,
      suggestions: 0,
    };
  }

  const lines = [
    "# Tributary schema file: the relationships your database doesn't declare.",
    "# Real foreign keys are followed automatically and shown as comments.",
    "# Review the guessed references and uncomment the right ones.",
    "version: 1",
    `defaultSchema: ${defaultSchema}`,
    "tables:",
  ];
  let suggestions = 0;
  for (const t of sorted) {
    lines.push(`  ${yamlKey(name(t))}:`);
    const fkColumns = new Set(t.foreignKeys.flatMap((fk) => fk.fromColumns));
    for (const fk of t.foreignKeys) {
      const to = fk.toColumns.map((c) => `${nameOf(fk.toTable)}.${c}`).join(", ");
      lines.push(
        `    # ${fk.fromColumns.join(", ")} -> ${to}  (database foreign key, followed already)`,
      );
    }
    const guesses: string[] = [];
    for (const c of t.columns) {
      if (!c.name.endsWith("_id") || c.name.length <= 3 || fkColumns.has(c.name)) continue;
      const base = c.name.slice(0, -3);
      const [best, ...others] = candidates(db, base);
      if (!best) {
        guesses.push(
          `      # ${yamlKey(c.name)}:   # no table matches "${base}"; fill in "table.column"`,
        );
        continue;
      }
      const also = others.length ? `; also: ${others.map(target).join(", ")}` : "";
      guesses.push(
        `      # ${yamlKey(c.name)}: ${target(best)}   # guessed from the column name${also}`,
      );
      suggestions++;
    }
    if (guesses.length) lines.push("    references:", ...guesses);
  }
  return { text: `${lines.join("\n")}\n`, tables: db.tables.length, suggestions };
}
