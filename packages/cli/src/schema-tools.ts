import type { Schema, Table } from "@bhuneshvar-k/tributary-core";

/** Tables with the same name and columns in several schemas (tenant copies), as one entry. */
interface TableGroup {
  name: string;
  /** Sorted; the first is the copy that gets described. */
  schemas: string[];
  table: Table;
}

export interface TableMatch {
  /** Bare table name; `schemas` says where it exists. */
  table: string;
  schemas: string[];
  matchingColumns: string[];
}

export interface TableDescription {
  /** "schema.table" of the copy described. */
  table: string;
  /** Other schemas holding an identical copy. */
  alsoIn: string[];
  primaryKey: string[];
  columns: { name: string; type: string; nullable: boolean }[];
  references: string[];
}

const MAX_RESULTS = 15;

/** The forms of a word to look for: as written, singular and plural. */
function wordForms(word: string): string[] {
  const forms = new Set([word]);
  if (word.endsWith("ies")) forms.add(`${word.slice(0, -3)}y`);
  else if (word.endsWith("s")) forms.add(word.slice(0, -1));
  if (word.endsWith("y")) forms.add(`${word.slice(0, -1)}ies`);
  else if (!word.endsWith("s")) forms.add(`${word}s`);
  return [...forms];
}

/**
 * Compact, on-demand views of a catalog for the AI command, so the model
 * looks up only what a request needs instead of receiving the whole
 * schema. Tenant schemas repeating the same tables collapse into one
 * entry each.
 */
export function schemaTools(catalog: Schema) {
  const groups = new Map<string, TableGroup>();
  for (const t of catalog.tables) {
    const signature = t.columns.map((c) => `${c.name}:${c.sqlType}`).join(",");
    const key = `${t.name}\0${signature}`;
    const group = groups.get(key);
    if (group) group.schemas.push(t.schema);
    else groups.set(key, { name: t.name, schemas: [t.schema], table: t });
  }
  for (const g of groups.values()) {
    g.schemas.sort();
    g.table = catalog.tables.find((t) => t.name === g.name && t.schema === g.schemas[0]) ?? g.table;
  }
  const sorted = [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.schemas[0]!.localeCompare(b.schemas[0]!),
  );

  return {
    listSchemas(): { schema: string; tables: number }[] {
      const counts = new Map<string, number>();
      for (const t of catalog.tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);
      return [...counts]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([schema, tables]) => ({ schema, tables }));
    },

    /** Tables whose name or columns contain the query's words; table-name matches rank first. */
    searchTables(query: string): TableMatch[] {
      const words = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
        .map(wordForms);
      const scored = sorted.flatMap((g) => {
        let score = 0;
        const matchingColumns = new Set<string>();
        for (const forms of words) {
          if (forms.some((f) => g.name.includes(f))) score += 3;
          for (const c of g.table.columns) {
            if (forms.some((f) => c.name.includes(f))) {
              matchingColumns.add(c.name);
              score += 1;
            }
          }
        }
        return score
          ? [
              {
                score,
                match: { table: g.name, schemas: g.schemas, matchingColumns: [...matchingColumns] },
              },
            ]
          : [];
      });
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((s) => s.match);
    },

    /** One table: "schema.table", or a bare name (described from its first schema). */
    describeTable(name: string): TableDescription | { error: string } {
      const dot = name.indexOf(".");
      const group =
        dot === -1
          ? sorted.find((g) => g.name === name)
          : sorted.find(
              (g) => g.name === name.slice(dot + 1) && g.schemas.includes(name.slice(0, dot)),
            );
      if (!group) return { error: `no table named "${name}"; use search_tables to find it` };
      const schema = dot === -1 ? group.schemas[0]! : name.slice(0, dot);
      const t = catalog.tables.find((x) => x.schema === schema && x.name === group.name)!;
      return {
        table: `${schema}.${t.name}`,
        alsoIn: group.schemas.filter((s) => s !== schema),
        primaryKey: t.primaryKey,
        columns: t.columns.map((c) => ({ name: c.name, type: c.sqlType, nullable: c.nullable })),
        references: t.foreignKeys.map(
          (fk) =>
            `${fk.fromColumns.join(", ")} -> ${fk.toColumns.map((c) => `${fk.toTable}.${c}`).join(", ")}`,
        ),
      };
    },
  };
}

export type SchemaTools = ReturnType<typeof schemaTools>;
