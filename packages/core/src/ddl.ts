import { type Schema, type Table, tableId } from "./catalog.js";
import { ident, literal, type Queryable, qualified } from "./db.js";
import type { NodeId } from "./graph.js";
import { inspect } from "./inspect.js";

/** What ensureSchema created on the target. */
export interface SchemaReport {
  typesCreated: string[];
  tablesCreated: NodeId[];
  constraintsCreated: string[];
  warnings: string[];
}

/**
 * Makes sure every table in `tables` exists on the target. Missing ones
 * are created from the source schema (columns with their exact types,
 * NOT NULL, PRIMARY KEY), and once all of them exist their real FOREIGN
 * KEY constraints are added, so cyclic constraints need no creation
 * order. Missing enum types are created too; other custom types
 * (domains, composites, ranges) must already exist on the target.
 *
 * Tables already on the target are checked for compatibility instead of
 * altered. Everything created happens in one transaction.
 *
 * Not replicated: defaults, sequences/identity, check constraints,
 * indexes beyond the primary key, triggers, views.
 */
export async function ensureSchema(
  target: Queryable,
  source: Schema,
  tables: Iterable<NodeId>,
  createMissing: boolean,
): Promise<SchemaReport> {
  const report: SchemaReport = {
    typesCreated: [],
    tablesCreated: [],
    constraintsCreated: [],
    warnings: [],
  };
  const sourceTables = new Map(source.tables.map((t) => [tableId(t), t]));
  const existing = new Map(
    (await inspect(target)).tables.map((t) => [tableId(t), t]),
  );

  const missing: Table[] = [];
  for (const id of [...tables].sort()) {
    const src = sourceTables.get(id);
    if (!src)
      throw new Error(
        `internal error: ${id} has rows but is missing from the source schema`,
      );
    const tgt = existing.get(id);
    if (tgt) checkCompatible(tgt, src);
    else missing.push(src);
  }
  if (missing.length === 0) return report;

  if (!createMissing) {
    throw new Error(
      `target is missing ${missing.length} table(s) needed by this subset and schema creation is off: ${missing.map(tableId).join(", ")}`,
    );
  }

  await target.query("BEGIN");
  try {
    report.typesCreated = await ensureTypes(target, source.enums, missing);
    for (const schemaName of new Set(missing.map((t) => t.schema))) {
      await target.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schemaName)}`);
    }
    for (const t of missing) {
      await target.query(createTableSql(t));
      report.tablesCreated.push(tableId(t));
      existing.set(tableId(t), t);
    }
    for (const t of missing) {
      for (const fk of t.foreignKeys) {
        if (!existing.has(fk.toTable)) {
          report.warnings.push(
            `did not create foreign key ${fk.constraintName} (${fk.fromTable} -> ${fk.toTable}): the referenced table is outside this subset and doesn't exist on target`,
          );
          continue;
        }
        await target.query(
          `ALTER TABLE ${qualified(fk.fromTable)} ADD CONSTRAINT ${ident(fk.constraintName)} FOREIGN KEY (${fk.fromColumns.map(ident).join(", ")}) REFERENCES ${qualified(fk.toTable)} (${fk.toColumns.map(ident).join(", ")})`,
        );
        report.constraintsCreated.push(fk.constraintName);
      }
    }
    await target.query("COMMIT");
  } catch (e) {
    await target.query("ROLLBACK");
    throw e;
  }
  return report;
}

/**
 * Every source column must exist on the target, and a nullable source
 * column can't be NOT NULL there. Extra target-only columns are fine.
 */
function checkCompatible(target: Table, source: Table): void {
  const id = tableId(source);
  for (const sc of source.columns) {
    const tc = target.columns.find((c) => c.name === sc.name);
    if (!tc)
      throw new Error(
        `target table ${id} is missing column "${sc.name}" that the source has`,
      );
    if (sc.nullable && !tc.nullable) {
      throw new Error(
        `target table ${id}: column "${sc.name}" is nullable in source but NOT NULL on target`,
      );
    }
  }
}

async function ensureTypes(
  target: Queryable,
  enums: Record<string, string[]>,
  tables: Table[],
) {
  const created: string[] = [];
  const checked = new Set<string>();
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.type !== "USER-DEFINED" || checked.has(c.udtName)) continue;
      checked.add(c.udtName);
      const { rows } = await target.query(
        "SELECT 1 FROM pg_type WHERE typname = $1",
        [c.udtName],
      );
      if (rows.length) continue;
      const labels = enums[c.udtName];
      if (!labels) {
        throw new Error(
          `column ${tableId(t)}.${c.name} uses type "${c.udtName}", which doesn't exist on the target and isn't an enum; create it there first (tributary auto-creates enums, not domains, composites or ranges)`,
        );
      }
      await target.query(
        `CREATE TYPE ${ident(c.udtName)} AS ENUM (${labels.map(literal).join(", ")})`,
      );
      created.push(c.udtName);
    }
  }
  return created;
}

function createTableSql(t: Table): string {
  const lines = t.columns.map(
    (c) => `${ident(c.name)} ${c.sqlType}${c.nullable ? "" : " NOT NULL"}`,
  );
  if (t.primaryKey.length)
    lines.push(`PRIMARY KEY (${t.primaryKey.map(ident).join(", ")})`);
  return `CREATE TABLE ${qualified(tableId(t))} (\n  ${lines.join(",\n  ")}\n)`;
}
