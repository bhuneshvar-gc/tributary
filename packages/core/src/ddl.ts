import { customType, findColumn, type Schema, type Table, tableId } from "./catalog.js";
import { ident, literal, type Queryable, qualified, splitQualified, transaction } from "./db.js";
import type { NodeId } from "./graph.js";
import { inspect } from "./inspect.js";

/** What ensureSchema created on the target. */
export interface SchemaReport {
  /** "schema.type" names. */
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
 * order. Missing enum types (including ones only used as array elements)
 * are created in their own schema; other custom types (domains,
 * composites, ranges) must already exist on the target.
 *
 * Tables already on the target are checked for compatibility instead of
 * altered. Everything created happens in one transaction.
 *
 * Not replicated: defaults, sequences/identity, check constraints,
 * indexes beyond the primary key (and the unique keys foreign keys need),
 * triggers, views.
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
  const existing = new Map((await inspect(target)).tables.map((t) => [tableId(t), t]));

  const missing: Table[] = [];
  for (const id of [...tables].sort()) {
    const src = sourceTables.get(id);
    if (!src)
      throw new Error(`internal error: ${id} has rows but is missing from the source schema`);
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

  await transaction(target, async () => {
    const types = typesNeeded(missing);
    const schemas = new Set([
      ...missing.map((t) => t.schema),
      ...[...types.keys()].map((type) => splitQualified(type).schema),
    ]);
    for (const name of schemas) await target.query(`CREATE SCHEMA IF NOT EXISTS ${ident(name)}`);
    report.typesCreated = await ensureTypes(target, source.enums, types);
    for (const t of missing) {
      await target.query(createTableSql(t));
      report.tablesCreated.push(tableId(t));
      existing.set(tableId(t), t);
    }
    const created = new Set(report.tablesCreated);
    const uniqueKeys = new Set<string>();
    for (const t of missing) {
      for (const fk of t.foreignKeys) {
        if (!existing.has(fk.toTable)) {
          report.warnings.push(
            `did not create foreign key ${fk.constraintName} (${fk.fromTable} -> ${fk.toTable}): the referenced table is outside this subset and doesn't exist on target`,
          );
          continue;
        }
        // A foreign key onto columns other than the primary key needs a
        // unique constraint on them, which a table created here lacks.
        const parent = existing.get(fk.toTable)!;
        const key = `${fk.toTable}\0${columnSet(fk.toColumns)}`;
        if (
          created.has(fk.toTable) &&
          columnSet(fk.toColumns) !== columnSet(parent.primaryKey) &&
          !uniqueKeys.has(key)
        ) {
          await target.query(
            `ALTER TABLE ${qualified(fk.toTable)} ADD UNIQUE (${fk.toColumns.map(ident).join(", ")})`,
          );
          uniqueKeys.add(key);
        }
        // A table already on the target may lack the unique key the foreign
        // key needs; that skips the constraint instead of the whole schema.
        await target.query("SAVEPOINT tributary_fk");
        try {
          await target.query(
            `ALTER TABLE ${qualified(fk.fromTable)} ADD CONSTRAINT ${ident(fk.constraintName)} FOREIGN KEY (${fk.fromColumns.map(ident).join(", ")}) REFERENCES ${qualified(fk.toTable)} (${fk.toColumns.map(ident).join(", ")})`,
          );
        } catch (e) {
          if ((e as { code?: string }).code !== "42830") throw e;
          await target.query("ROLLBACK TO SAVEPOINT tributary_fk");
          report.warnings.push(
            `did not create foreign key ${fk.constraintName} (${fk.fromTable} -> ${fk.toTable}): ${fk.toTable} on target has no unique key on (${fk.toColumns.join(", ")})`,
          );
          continue;
        }
        await target.query("RELEASE SAVEPOINT tributary_fk");
        report.constraintsCreated.push(fk.constraintName);
      }
    }
  });
  return report;
}

/** A key's columns, independent of order: Postgres matches unique keys by column set. */
function columnSet(columns: string[]): string {
  return [...columns].sort().join("\0");
}

/**
 * Every source column must exist on the target, and a nullable source
 * column can't be NOT NULL there. Extra target-only columns are fine.
 */
function checkCompatible(target: Table, source: Table): void {
  const id = tableId(source);
  for (const sc of source.columns) {
    const tc = findColumn(target, sc.name);
    if (!tc)
      throw new Error(`target table ${id} is missing column "${sc.name}" that the source has`);
    if (sc.nullable && !tc.nullable) {
      throw new Error(
        `target table ${id}: column "${sc.name}" is nullable in source but NOT NULL on target`,
      );
    }
  }
}

/** Custom type ("schema.type") -> the first column using it, for error messages. */
function typesNeeded(tables: Table[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const t of tables) {
    for (const c of t.columns) {
      const type = customType(c);
      if (type && !types.has(type)) types.set(type, `${tableId(t)}.${c.name}`);
    }
  }
  return types;
}

async function ensureTypes(
  target: Queryable,
  enums: Record<string, string[]>,
  types: Map<string, string>,
): Promise<string[]> {
  const created: string[] = [];
  for (const [type, usedBy] of types) {
    const { schema, name } = splitQualified(type);
    const { rows } = await target.query(
      "SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2",
      [schema, name],
    );
    if (rows.length) continue;
    const labels = enums[type];
    if (!labels) {
      throw new Error(
        `column ${usedBy} uses type "${type}", which doesn't exist on the target and isn't an enum; create it there first (tributary auto-creates enums, not domains, composites or ranges)`,
      );
    }
    await target.query(
      `CREATE TYPE ${qualified(type)} AS ENUM (${labels.map(literal).join(", ")})`,
    );
    created.push(type);
  }
  return created;
}

function createTableSql(t: Table): string {
  const lines = t.columns.map(
    (c) => `${ident(c.name)} ${c.sqlType}${c.nullable ? "" : " NOT NULL"}`,
  );
  if (t.primaryKey.length) lines.push(`PRIMARY KEY (${t.primaryKey.map(ident).join(", ")})`);
  return `CREATE TABLE ${qualified(tableId(t))} (\n  ${lines.join(",\n  ")}\n)`;
}
