import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { startPostgres, type TestPostgres } from "../../core/test/support/postgres.js";
import { testCli } from "./support/cli.js";

const fixture = readFileSync(
  new URL("../../core/test/fixtures/source.sql", import.meta.url),
  "utf8",
);

let source: TestPostgres;
beforeAll(async () => {
  source = await startPostgres();
  await source.exec(fixture);
  await source.exec(`
    insert into parent_table values (1, 'p1');
    insert into child_table values (10, 1, 'c10');
    insert into leaf_table values (7, 'l7');
    insert into poly_target_a values (1, 'a1');
    insert into poly_source_table values (1, 'A', 1);`);
});
afterAll(() => source.close());

const POLYMORPHIC_YAML = `version: 1
tables:
  poly_source_table:
    polymorphic:
      target_id:
        typeColumn: target_type
        targets: { A: poly_target_a.id, B: poly_target_b.id }
`;

/** A CLI with a "src" connection to the fixture database. */
function cliWithSource() {
  const cli = testCli();
  cli.userConfig.set("connections.src.url", source.url);
  return cli;
}

/** Tables in `plan --json` output. */
function planned(stdout: string): string[] {
  return (JSON.parse(stdout) as { tables: { table: string }[] }).tables.map((t) => t.table);
}

describe("schema file discovery", () => {
  test("schema.yaml in the working directory is used, and says so", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.yaml"), POLYMORPHIC_YAML);

    const result = await cli.run(
      "plan",
      "--source",
      "src",
      "-t",
      "poly_source_table",
      "-w",
      "id = 1",
      "--json",
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("using schema ./schema.yaml");
    expect(planned(result.stdout)).toContain("public.poly_target_a");
  });

  test("schema.yaml wins over schema.yml and schema.json", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.yaml"), POLYMORPHIC_YAML);
    writeFileSync(join(cli.cwd, "schema.yml"), "not: [valid");
    writeFileSync(join(cli.cwd, "schema.json"), "{");

    const result = await cli.run(
      "plan",
      "--source",
      "src",
      "-t",
      "poly_source_table",
      "-w",
      "id = 1",
      "--json",
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("using schema ./schema.yaml");
  });

  test("schema.json is found when it's the only one", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.json"), JSON.stringify(parseYaml(POLYMORPHIC_YAML)));

    const result = await cli.run(
      "plan",
      "--source",
      "src",
      "-t",
      "poly_source_table",
      "-w",
      "id = 1",
      "--json",
    );

    expect(result.stderr).toContain("using schema ./schema.json");
    expect(planned(result.stdout)).toContain("public.poly_target_a");
  });

  test("--schema takes any path, and nothing is auto-detected then", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "relations.yaml"), POLYMORPHIC_YAML);
    writeFileSync(join(cli.cwd, "schema.yaml"), "openapi: 3.0.0\n");

    const result = await cli.run(
      "plan",
      "--source",
      "src",
      "-t",
      "poly_source_table",
      "-w",
      "id = 1",
      "--schema",
      "relations.yaml",
      "--json",
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("using schema relations.yaml");
    expect(planned(result.stdout)).toContain("public.poly_target_a");
  });

  test("an auto-detected file that isn't a tributary schema is an error naming it", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.yaml"), "openapi: 3.0.0\n");

    const result = await cli.run("plan", "--source", "src", "-t", "leaf_table", "-w", "true");

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /schema\.yaml: invalid schema file:\n\s+- not a tributary schema file/,
    );
  });

  test("with no schema file, only database foreign keys are followed, with a note", async () => {
    const cli = cliWithSource();

    const result = await cli.run(
      "plan",
      "--source",
      "src",
      "-t",
      "poly_source_table",
      "-w",
      "id = 1",
      "--json",
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "no schema file: following database foreign keys only (see tributary schema init)",
    );
    expect(planned(result.stdout)).toEqual(["public.poly_source_table"]);
  });
});

describe("seeds", () => {
  test("repeated -t/-w pairs are all seeds of one subset", async () => {
    const cli = cliWithSource();

    const result = await cli.run(
      "plan",
      "--source",
      "src",
      "-t",
      "parent_table",
      "-w",
      "id = 1",
      "-t",
      "leaf_table",
      "-w",
      "true",
      "--json",
    );

    expect(planned(result.stdout).sort()).toEqual([
      "public.child_table",
      "public.leaf_table",
      "public.parent_table",
    ]);
  });

  test("a -t without its -w is an error", async () => {
    const result = await cliWithSource().run(
      "plan",
      "--source",
      "src",
      "-t",
      "parent_table",
      "-t",
      "leaf_table",
      "-w",
      "true",
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "every --seed-table needs a --where (got 2 tables and 1 where)",
    );
  });

  test("plan needs at least one seed", async () => {
    const result = await cliWithSource().run("plan", "--source", "src");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "no seed: pass --seed-table <table> --where <sql> (repeat the pair for more)",
    );
  });

  test("--source is required", async () => {
    const result = await cliWithSource().run("plan", "-t", "leaf_table", "-w", "true");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("required option '-s, --source <name>' not specified");
  });
});

describe("schema init", () => {
  test("writes ./schema.yaml from the source, with guesses commented out", async () => {
    const cli = cliWithSource();

    const result = await cli.run("schema", "init", "--source", "src");

    expect(result.code).toBe(0);
    const text = readFileSync(join(cli.cwd, "schema.yaml"), "utf8");
    expect(text).toContain("\n  poly_source_table:\n");
    expect(text).toContain(
      "# parent_id -> parent_table.id  (database foreign key, followed already)",
    );
    expect(result.stdout).toMatch(
      /^wrote \.\/schema\.yaml: \d+ tables, \d+ guessed references to review\n$/,
    );
  });

  test("refuses to overwrite an existing file unless --force", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.yaml"), "version: 1\n# my edits\n");

    const refused = await cli.run("schema", "init", "--source", "src");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("./schema.yaml already exists; pass --force to overwrite it");
    expect(readFileSync(join(cli.cwd, "schema.yaml"), "utf8")).toContain("# my edits");

    expect((await cli.run("schema", "init", "--source", "src", "--force")).code).toBe(0);
    expect(readFileSync(join(cli.cwd, "schema.yaml"), "utf8")).not.toContain("# my edits");
  });

  test("-o picks the path and --format json writes JSON", async () => {
    const cli = cliWithSource();

    const result = await cli.run(
      "schema",
      "init",
      "--source",
      "src",
      "-o",
      "db/relations.json",
      "--format",
      "json",
    );

    expect(result.code).toBe(0);
    const data = JSON.parse(readFileSync(join(cli.cwd, "db/relations.json"), "utf8"));
    expect(data).toMatchObject({ version: 1, defaultSchema: "public" });
    expect(existsSync(join(cli.cwd, "schema.yaml"))).toBe(false);
    expect(result.stderr).toContain("JSON can't hold comments");
  });
});

describe("schema validate", () => {
  test("a well-formed file passes", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.yaml"), POLYMORPHIC_YAML);

    expect(await cli.run("schema", "validate")).toMatchObject({
      code: 0,
      stdout: "./schema.yaml: valid\n",
    });
  });

  test("format problems fail with every issue listed", async () => {
    const cli = cliWithSource();
    writeFileSync(
      join(cli.cwd, "bad.yaml"),
      "version: 1\ntables:\n  a:\n    references: { x: nodot }\n    oops: true\n",
    );

    const result = await cli.run("schema", "validate", "--schema", "bad.yaml");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('tables.a: Unrecognized key: "oops"');
  });

  test("with --source, tables and columns must exist in that database", async () => {
    const cli = cliWithSource();
    writeFileSync(
      join(cli.cwd, "schema.yaml"),
      "version: 1\ntables:\n  leaf_table:\n    references:\n      nope_id: parent_table.id\n",
    );

    const result = await cli.run("schema", "validate", "--source", "src");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'tables.leaf_table.references.nope_id: from=public.leaf_table.nope_id: no such column "nope_id" on "public.leaf_table"',
    );
  });

  test("with no file to validate, it says so", async () => {
    const result = await cliWithSource().run("schema", "validate");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "no schema file: pass --schema <file> or create ./schema.yaml (tributary schema init)",
    );
  });
});
