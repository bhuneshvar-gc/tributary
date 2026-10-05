import {
  type Column,
  type ForeignKey,
  type Schema,
  type Table,
  tableId,
} from "./catalog.js";
import { type Queryable, withClient } from "./db.js";

/** Schemas never reported: system catalogs and Tributary's own state. */
const HIDDEN = `('pg_catalog', 'information_schema', 'pg_toast', '_tributary')`;

const int = (v: string | null | undefined) =>
  v == null ? undefined : Number(v);

/**
 * Reads the database's base tables, columns, primary keys, foreign keys
 * and enum types from information_schema and pg_catalog.
 */
export async function inspect(source: string | Queryable): Promise<Schema> {
  return withClient(source, async (db) => {
    const tables = new Map<string, Table>();

    // A domain column reports its base type as data_type; report it as
    // USER-DEFINED with the domain's name so load treats it as a custom type.
    const columns = await db.query(`
      select c.table_schema, c.table_name, c.column_name, c.is_nullable,
        case when c.domain_name is not null then 'USER-DEFINED' else c.data_type end as data_type,
        coalesce(c.domain_name, c.udt_name) as udt_name,
        c.character_maximum_length, c.numeric_precision, c.numeric_scale,
        format_type(a.atttypid, a.atttypmod) as sql_type
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      join pg_attribute a
        on a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
        and a.attname = c.column_name
      where t.table_type = 'BASE TABLE' and c.table_schema not in ${HIDDEN}
      order by c.table_schema, c.table_name, c.ordinal_position`);
    for (const r of columns.rows) {
      const id = `${r.table_schema}.${r.table_name}`;
      let t = tables.get(id);
      if (!t) {
        t = {
          schema: r.table_schema!,
          name: r.table_name!,
          columns: [],
          primaryKey: [],
          foreignKeys: [],
        };
        tables.set(id, t);
      }
      const column: Column = {
        name: r.column_name!,
        type: r.data_type!,
        udtName: r.udt_name!,
        sqlType: r.sql_type!,
        nullable: r.is_nullable === "YES",
      };
      const charMaxLength = int(r.character_maximum_length);
      const numericPrecision = int(r.numeric_precision);
      const numericScale = int(r.numeric_scale);
      if (charMaxLength !== undefined) column.charMaxLength = charMaxLength;
      if (numericPrecision !== undefined)
        column.numericPrecision = numericPrecision;
      if (numericScale !== undefined) column.numericScale = numericScale;
      t.columns.push(column);
    }

    const pks = await db.query(`
      select nsp.nspname || '.' || rel.relname as table_id, att.attname as column_name
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
      where con.contype = 'p'
      order by table_id, k.ord`);
    for (const r of pks.rows)
      tables.get(r.table_id!)?.primaryKey.push(r.column_name!);

    // Constraint names are only unique per table, so group by table + name.
    const fks = await db.query(`
      select con.conname,
        nsp.nspname || '.' || rel.relname as from_table, att.attname as from_column,
        fnsp.nspname || '.' || frel.relname as to_table, fatt.attname as to_column
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      join pg_class frel on frel.oid = con.confrelid
      join pg_namespace fnsp on fnsp.oid = frel.relnamespace
      join lateral unnest(con.conkey, con.confkey) with ordinality as k(from_attnum, to_attnum, ord) on true
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.from_attnum
      join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = k.to_attnum
      where con.contype = 'f'
      order by from_table, con.conname, k.ord`);
    const byConstraint = new Map<string, ForeignKey>();
    for (const r of fks.rows) {
      const key = `${r.from_table}\0${r.conname}`;
      let fk = byConstraint.get(key);
      if (!fk) {
        fk = {
          constraintName: r.conname!,
          fromTable: r.from_table!,
          fromColumns: [],
          toTable: r.to_table!,
          toColumns: [],
        };
        byConstraint.set(key, fk);
        tables.get(fk.fromTable)?.foreignKeys.push(fk);
      }
      fk.fromColumns.push(r.from_column!);
      fk.toColumns.push(r.to_column!);
    }

    const enumRows = await db.query(`
      select t.typname, e.enumlabel
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname not in ${HIDDEN}
      order by t.typname, e.enumsortorder`);
    const enums: Record<string, string[]> = {};
    for (const r of enumRows.rows) {
      enums[r.typname!] ??= [];
      enums[r.typname!]!.push(r.enumlabel!);
    }

    return {
      tables: [...tables.values()].sort((a, b) =>
        tableId(a).localeCompare(tableId(b)),
      ),
      enums,
    };
  });
}
