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
function cliWithSource(answers?: boolean[]) {
  const cli = testCli(answers ? { terminal: { confirms: answers } } : {});
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

  test("a -t without a -w takes the whole table", async () => {
    const result = await cliWithSource().run(
      "plan",
      "--source",
      "src",
      "-t",
      "parent_table",
      "--json",
    );

    expect(result.code).toBe(0);
    const tables = JSON.parse(result.stdout).tables as { table: string; rows: number }[];
    expect(tables.find((t) => t.table === "public.parent_table")?.rows).toBe(1); // every row (the fixture has one)
    expect(result.stderr).toContain("no --where for public.parent_table: taking every row");
  });

  test("an empty or blank -w also takes the whole table", async () => {
    for (const where of ["", "   "]) {
      const result = await cliWithSource().run(
        "plan",
        "--source",
        "src",
        "-t",
        "parent_table",
        "-w",
        where,
        "--json",
      );
      expect(result.code).toBe(0);
      expect(planned(result.stdout)).toContain("public.parent_table");
      expect(result.stderr).toContain("no --where for public.parent_table: taking every row");
    }
  });

  test("each -w belongs to the -t written just before it", async () => {
    const result = await cliWithSource().run(
      "plan",
      "--source",
      "src",
      "-t",
      "leaf_table",
      "-t",
      "parent_table",
      "-w",
      "id = 999",
      "--json",
    );

    expect(result.code).toBe(0);
    // leaf_table: whole table (1 row); parent_table: id = 999 matches nothing
    expect(planned(result.stdout)).toEqual(["public.leaf_table"]);
  });

  test("a -w with no -t before it is an error", async () => {
    const result = await cliWithSource().run(
      "plan",
      "--source",
      "src",
      "-w",
      "id = 1",
      "-t",
      "leaf_table",
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--where must come right after the --seed-table it filters");
  });

  test("two -w for one -t is an error", async () => {
    const result = await cliWithSource().run(
      "plan",
      "--source",
      "src",
      "-t",
      "leaf_table",
      "-w",
      "true",
      "-w",
      "id = 1",
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("public.leaf_table already has a --where");
  });

  test("a bare seed table resolves in the schema file's defaultSchema", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.yaml"), "version: 1\ndefaultSchema: billing\n");

    const result = await cli.run(
      "plan",
      "--source",
      "src",
      "-t",
      "invoice",
      "-w",
      "true",
      "--json",
    );

    expect(result.stderr).not.toContain("no such table");
    expect(result.code).toBe(0); // billing.invoice exists (empty); public.invoice doesn't
  });

  test("plan needs at least one seed", async () => {
    const result = await cliWithSource().run("plan", "--source", "src");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "no seed: pass --seed-table <table> [--where <sql>] (repeat for more)",
    );
  });

  test("--source is required", async () => {
    const result = await cliWithSource().run("plan", "-t", "leaf_table", "-w", "true");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("required option '-s, --source <name>' not specified");
  });
});

describe("schema init", () => {
  test("writes ./schema.yaml from the source, every table schema-qualified", async () => {
    const cli = cliWithSource();

    const result = await cli.run("schema", "init", "--source", "src");

    expect(result.code).toBe(0);
    const text = readFileSync(join(cli.cwd, "schema.yaml"), "utf8");
    expect(text).toContain("\n  public.poly_source_table:\n    references:\n      # target_id:\n");
    expect(text).toContain(
      "# parent_id -> public.parent_table.id  (database foreign key, followed already)",
    );
    expect(result.stdout).toMatch(
      /^wrote \.\/schema\.yaml: \d+ tables, \d+ \*_id columns to fill in\n$/,
    );
  });

  test("asks before overwriting an existing file, and overwrites on yes", async () => {
    const cli = cliWithSource([true]);
    writeFileSync(join(cli.cwd, "schema.yaml"), "version: 1\n# my edits\n");

    const result = await cli.run("schema", "init", "--source", "src");

    expect(cli.prompts).toEqual(["./schema.yaml already exists. Overwrite it?"]);
    expect(result.code).toBe(0);
    expect(readFileSync(join(cli.cwd, "schema.yaml"), "utf8")).not.toContain("# my edits");
  });

  test("answering no keeps the existing file", async () => {
    const cli = cliWithSource([false]);
    writeFileSync(join(cli.cwd, "schema.yaml"), "version: 1\n# my edits\n");

    const result = await cli.run("schema", "init", "--source", "src");

    expect(result).toMatchObject({ code: 0, stdout: "kept ./schema.yaml; nothing written\n" });
    expect(readFileSync(join(cli.cwd, "schema.yaml"), "utf8")).toContain("# my edits");
  });

  test("--force overwrites without asking", async () => {
    const cli = cliWithSource([false]);
    writeFileSync(join(cli.cwd, "schema.yaml"), "version: 1\n# my edits\n");

    expect((await cli.run("schema", "init", "--source", "src", "--force")).code).toBe(0);
    expect(cli.prompts).toEqual([]);
    expect(readFileSync(join(cli.cwd, "schema.yaml"), "utf8")).not.toContain("# my edits");
  });

  test("with nobody to ask (not a terminal), refuses to overwrite unless --force", async () => {
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

  test("with --source, a misspelled table is caught even with nothing declared under it", async () => {
    const cli = cliWithSource();
    writeFileSync(join(cli.cwd, "schema.yaml"), "version: 1\ntables:\n  public.leaf_tabel:\n");

    const result = await cli.run("schema", "validate", "--source", "src");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'tables."public.leaf_tabel": no such table "public.leaf_tabel" in the database',
    );
  });

  test("errors name the file as given, not its absolute path", async () => {
    const cli = cliWithSource();
    writeFileSync(
      join(cli.cwd, "schema.yaml"),
      "version: 1\ntables:\n  a: { references: { x: bad } }\n",
    );

    const result = await cli.run("schema", "validate");

    expect(result.stderr).toContain("./schema.yaml: invalid schema file");
    expect(result.stderr).not.toContain(cli.cwd);
  });

  test("with no file to validate, it says so", async () => {
    const result = await cliWithSource().run("schema", "validate");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "no schema file: pass --schema <file> or create ./schema.yaml (tributary schema init)",
    );
  });
});

test("plan shows its progress while collecting the subset", async () => {
  const progress: string[] = [];
  const cli = testCli({ progress: (m) => progress.push(m) });
  cli.userConfig.set("connections.src.url", source.url);

  const result = await cli.run(
    "plan",
    "--source",
    "src",
    "-t",
    "parent_table",
    "-w",
    "id = 1",
    "--json",
  );

  expect(result.code).toBe(0);
  expect(progress[0]).toBe("reading the source schema");
  expect(progress.at(-1)).toBe("collecting the subset: 2 rows across 2 tables");
  expect(result.stdout).toMatch(/"durationMs": [\d.]+/);
});

test("plan prints how long it took", async () => {
  const cli = cliWithSource();

  const result = await cli.run("plan", "--source", "src", "-t", "parent_table", "-w", "id = 1");

  expect(result.stdout).toMatch(/total: 2 rows across 2 tables, in [\d.]+m?s\n/);
});

test("sync shows each step of the load as it goes", async () => {
  const target = await startPostgres();
  try {
    const steps: [string, string | undefined][] = [];
    const cli = testCli({ progress: (m, step) => steps.push([m, step]) });
    cli.userConfig.set("connections.src.url", source.url);
    cli.userConfig.set("connections.dst.url", target.url);
    cli.userConfig.set("allowlist", "127.0.0.1");

    const result = await cli.run(
      "sync",
      "--source",
      "src",
      "--target",
      "dst",
      "-t",
      "parent_table",
      "-w",
      "id = 1",
    );

    expect(result.code).toBe(0);
    // The last message of each step is what stays on screen.
    const last = new Map(steps.map(([m, step]) => [step, m]));
    expect([...last.values()]).toEqual([
      "reading the source schema",
      "collecting the subset: 2 rows across 2 tables",
      "checking target tables, creating missing ones",
      "[1/2] public.parent_table: 1 row copied into a new table",
      "[2/2] public.child_table: 1 row copied into a new table",
      "updating planner statistics [2/2]: public.child_table",
    ]);
  } finally {
    await target.close();
  }
});

describe("sync output", () => {
  test("shows how each table was loaded and how many rows were written or unchanged", async () => {
    const target = await startPostgres();
    try {
      const cli = cliWithSource();
      cli.userConfig.set("connections.dst.url", target.url);
      cli.userConfig.set("allowlist", "127.0.0.1");

      const first = await cli.run(
        "sync",
        "--source",
        "src",
        "--target",
        "dst",
        "-t",
        "parent_table",
        "-w",
        "id = 1",
      );
      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(/public\.parent_table\s*│\s*new table\s*│\s*1\s*│\s*0/);
      expect(first.stdout).toMatch(
        /total: 2 rows written, 0 unchanged across 2 tables, in [\d.]+m?s \(run \w+\)/,
      );

      const second = await cli.run(
        "sync",
        "--source",
        "src",
        "--target",
        "dst",
        "-t",
        "parent_table",
        "-w",
        "id = 1",
      );
      expect(second.stdout).toMatch(/public\.parent_table\s*│\s*upsert\s*│\s*0\s*│\s*1/);
      expect(second.stdout).toContain("total: 0 rows written, 2 unchanged");
    } finally {
      await target.close();
    }
  });
});
