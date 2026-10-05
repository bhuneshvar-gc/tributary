import { type Schema, type Table, tableId } from "./catalog.js";

export interface SchemaTemplate {
  text: string;
  /** Tables listed. */
  tables: number;
  /** `*_id` columns without a foreign key, listed for the user to fill in. */
  candidates: number;
}

function yamlKey(name: string): string {
  return /^[\w.$-]+$/.test(name) ? name : JSON.stringify(name);
}

/** `*_id` columns that no real foreign key covers: likely app-level references. */
function unlinkedIdColumns(t: Table): string[] {
  const linked = new Set(t.foreignKeys.flatMap((fk) => fk.fromColumns));
  return t.columns
    .map((c) => c.name)
    .filter((n) => n.endsWith("_id") && n.length > 3 && !linked.has(n));
}

/**
 * Writes a starting schema file for a database. Every table is listed
 * by its schema-qualified name (public included), with its real foreign
 * keys as comments, since those are followed already, and each `*_id`
 * column without one as a bare commented key (`# order_id:`) for the
 * user to fill in. Nothing is guessed. JSON can't hold comments, so a
 * JSON template only lists the tables.
 */
export function schemaTemplate(
  db: Schema,
  options: { format?: "yaml" | "json" } = {},
): SchemaTemplate {
  const sorted = [...db.tables].sort((a, b) => tableId(a).localeCompare(tableId(b)));

  if (options.format === "json") {
    const tables = Object.fromEntries(sorted.map((t) => [tableId(t), {}]));
    const candidates = sorted.reduce((n, t) => n + unlinkedIdColumns(t).length, 0);
    return {
      text: `${JSON.stringify({ version: 1, defaultSchema: "public", tables }, null, 2)}\n`,
      tables: sorted.length,
      candidates,
    };
  }

  const lines = [
    "# Tributary schema file: the relationships your database doesn't declare.",
    "# Real foreign keys are followed automatically and shown as comments.",
    '# For each listed column that references another table, uncomment it and add "schema.table.column".',
    "version: 1",
    "defaultSchema: public",
    "tables:",
  ];
  let candidates = 0;
  for (const t of sorted) {
    lines.push(`  ${yamlKey(tableId(t))}:`);
    for (const fk of t.foreignKeys) {
      const to = fk.toColumns.map((c) => `${fk.toTable}.${c}`).join(", ");
      lines.push(
        `    # ${fk.fromColumns.join(", ")} -> ${to}  (database foreign key, followed already)`,
      );
    }
    const unlinked = unlinkedIdColumns(t);
    if (unlinked.length)
      lines.push("    references:", ...unlinked.map((c) => `      # ${yamlKey(c)}:`));
    candidates += unlinked.length;
  }
  return { text: `${lines.join("\n")}\n`, tables: sorted.length, candidates };
}
