import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSchemaFile, type SchemaFile } from "@bhuneshvar-k/tributary-core";

/** Checked in this order when --schema isn't given; the first that exists wins. */
export const SCHEMA_FILE_NAMES = ["schema.yaml", "schema.yml", "schema.json"] as const;

/** The schema file to use: the explicit path, else the first of SCHEMA_FILE_NAMES in `cwd`. */
export function findSchemaFile(
  cwd: string,
  explicit?: string,
): { path: string; shown: string } | undefined {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new Error(`schema file not found: ${explicit}`);
    return { path, shown: explicit };
  }
  const name = SCHEMA_FILE_NAMES.find((n) => existsSync(join(cwd, n)));
  return name ? { path: join(cwd, name), shown: `./${name}` } : undefined;
}

/**
 * Loads the run's schema file, telling the user which one (or that there's
 * none, so only database foreign keys are followed).
 */
export async function loadRunSchema(
  cwd: string,
  explicit: string | undefined,
  note: (message: string) => void,
): Promise<SchemaFile | undefined> {
  const found = findSchemaFile(cwd, explicit);
  if (!found) {
    note("no schema file: following database foreign keys only (see tributary schema init)");
    return undefined;
  }
  note(`using schema ${found.shown}`);
  return loadSchemaFile(found.path).catch((e: unknown) => {
    throw relabel(e, found);
  });
}

/** Errors name the file as the user knows it (./schema.yaml), not its absolute path. */
export function relabel(e: unknown, file: { path: string; shown: string }): unknown {
  if (e instanceof Error) e.message = e.message.replaceAll(file.path, file.shown);
  return e;
}
