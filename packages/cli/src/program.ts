import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  checkSchemaFile,
  inspect,
  loadSchemaFile,
  type PlanResult,
  plan,
  qualifyTable,
  type SchemaFile,
  SchemaFileError,
  type Seed,
  type SubsetProgress,
  type SyncResult,
  schemaTemplate,
  sync,
  TRAVERSALS,
  type Traversal,
} from "@bhuneshvar-k/tributary-core";
import * as p from "@clack/prompts";
import Table from "cli-table3";
import { Command, Option } from "commander";
import pc from "picocolors";
import semver from "semver";
import { createModel, generateCommand, toCliArgs } from "./ai.js";
import { findSchemaFile, loadRunSchema, relabel } from "./schema-file.js";
import {
  type AvailableUpdate,
  CHECK_INTERVAL_MS,
  checkForUpdate,
  npmUpdateSource,
  type UpdateSource,
} from "./update-check.js";
import { openUserConfig, type UserConfigStore } from "./user-config.js";

// Both src/ and dist/ sit one level below the package root.
const { name: packageName, version } = createRequire(import.meta.url)("../package.json") as {
  name: string;
  version: string;
};

export interface ProgramContext {
  cwd: string;
  userConfig: UserConfigStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Asks a yes/no question (default no). Absent when nobody can answer
   * (not a terminal: CI, pipes), so commands fail with a hint instead.
   */
  confirm?: (message: string) => Promise<boolean>;
  /** Where new versions are looked up and installed from. */
  updates: UpdateSource;
  /** Shows what a long command is doing; absent when stderr isn't a terminal. */
  progress?: (message: string) => void;
}

/** A spinner on stderr whose text follows the work, started on first use. */
function terminalProgress() {
  if (!process.stderr.isTTY) return undefined;
  let spinner: ReturnType<typeof p.spinner> | undefined;
  return {
    update(message: string) {
      if (!spinner) {
        spinner = p.spinner({ output: process.stderr });
        spinner.start(message);
      } else spinner.message(message);
    },
    stop() {
      spinner?.stop();
      spinner = undefined;
    },
  };
}

function describeProgress(event: SubsetProgress): string {
  switch (event.phase) {
    case "inspecting":
      return "reading the source schema";
    case "collecting":
      return `collecting the subset: ${event.rows.toLocaleString("en-US")} rows across ${event.tables} tables`;
    case "loading":
      return `loading ${event.table} (${event.index}/${event.total})`;
  }
}

/** A y/N prompt on the terminal, or undefined when stdin/stderr aren't one. */
function terminalConfirm(): ProgramContext["confirm"] {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return async (message) => {
    const answer = await p.confirm({ message, initialValue: false, output: process.stderr });
    return !p.isCancel(answer) && answer;
  };
}

interface SubsetCommandOptions {
  source: string;
  schema?: string;
  seedTable: string[];
  where: string[];
  traversal?: Traversal;
  strictCycles?: boolean;
  json?: boolean;
}

interface SyncCommandOptions extends SubsetCommandOptions {
  target: string;
  fresh?: boolean;
  createSchema: boolean;
}

const collect = (value: string, previous: string[]) => [...previous, value];

/** --source; required unless `optional` describes what it's for. */
function sourceOption(optional?: string): Option {
  const option = new Option(
    "-s, --source <name>",
    optional ?? "source connection name (see tributary config set connections.<name>.url)",
  );
  return optional ? option : option.makeOptionMandatory();
}

function schemaOption(): Option {
  return new Option(
    "--schema <file>",
    "schema file with app-level relations (default: ./schema.yaml, ./schema.yml or ./schema.json)",
  );
}

/** The source database's catalog, by connection name. */
function inspectSource(ctx: ProgramContext, name: string) {
  return inspect(ctx.userConfig.connectionUrl(name));
}

function subsetOptions(cmd: Command): Command {
  return cmd
    .addOption(sourceOption())
    .addOption(schemaOption())
    .option(
      "-t, --seed-table <table>",
      'seed table, e.g. "users" or "billing.invoices" (repeatable)',
      collect,
      [],
    )
    .option(
      "-w, --where <sql>",
      'WHERE fragment for the matching --seed-table, e.g. "id = 42"',
      collect,
      [],
    )
    .addOption(
      new Option(
        "--traversal <mode>",
        "fan out from every row, not just the seeds' downstream",
      ).choices(TRAVERSALS),
    )
    .option("--strict-cycles", "fail on a foreign key cycle with no breakCycle entry")
    .option("--json", "print JSON");
}

/**
 * Pairs each --seed-table with the --where in the same position. Bare
 * table names resolve in the schema file's defaultSchema, as in the file.
 */
function seeds(
  opts: Pick<SubsetCommandOptions, "seedTable" | "where">,
  defaultSchema: string,
): Seed[] {
  const { seedTable: tables, where } = opts;
  if (tables.length !== where.length) {
    throw new Error(
      `every --seed-table needs a --where (got ${tables.length} --seed-table, ${where.length} --where)`,
    );
  }
  if (tables.length === 0)
    throw new Error("no seed: pass --seed-table <table> --where <sql> (repeat the pair for more)");
  return tables.map((table, i) => ({
    table: qualifyTable(table, defaultSchema),
    where: where[i]!,
  }));
}

/** Everything a plan or sync needs from the command line, resolved. */
async function subset(ctx: ProgramContext, opts: SubsetCommandOptions) {
  const source = ctx.userConfig.connectionUrl(opts.source);
  seeds(opts, "public"); // usage errors before any file or database work
  const schema = await loadRunSchema(ctx.cwd, opts.schema, (m) => ctx.stderr(`${pc.dim(m)}\n`));
  return {
    source,
    seeds: seeds(opts, schema?.defaultSchema ?? "public"),
    ...(schema && { schema }),
    ...(opts.traversal && { traversal: opts.traversal }),
    ...(opts.strictCycles && { strictCycles: true }),
    ...(ctx.progress && {
      onProgress: (event: SubsetProgress) => ctx.progress?.(describeProgress(event)),
    }),
  };
}

/** Prints `result` as JSON with --json, or with the human-readable printer. */
function output<T>(
  ctx: ProgramContext,
  json: boolean | undefined,
  result: T,
  print: (r: T) => void,
): void {
  if (json) ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else print(result);
}

export function createProgram(ctx: ProgramContext): Command {
  // exitOverride before adding commands: subcommands copy it on creation,
  // so usage errors throw back to run() instead of calling process.exit.
  const program = new Command("tributary")
    .exitOverride()
    .description("Copy referentially-consistent subsets of a Postgres database")
    .version(version)
    .showHelpAfterError()
    .configureOutput({ writeOut: ctx.stdout, writeErr: ctx.stderr });

  program
    .command("inspect")
    .description("print the source schema (tables, columns, keys) as JSON")
    .addOption(sourceOption())
    .action(async (opts: { source: string }) => {
      ctx.stdout(`${JSON.stringify(await inspectSource(ctx, opts.source), null, 2)}\n`);
    });

  subsetOptions(program.command("plan"))
    .description("compute the subset and report row counts per table, writing nothing")
    .action(async (opts: SubsetCommandOptions) => {
      output(ctx, opts.json, await plan(await subset(ctx, opts)), (r) => printPlan(ctx, r));
    });

  subsetOptions(program.command("sync"))
    .description("copy the subset from source into target (upserting; safe to re-run)")
    .requiredOption("-T, --target <name>", "target connection name")
    .option(
      "--fresh",
      "delete the subset's rows from target first, and don't resume an earlier run",
    )
    .option("--no-create-schema", "fail instead of creating missing target tables")
    .action(async (opts: SyncCommandOptions) => {
      const result = await sync({
        ...(await subset(ctx, opts)),
        target: ctx.userConfig.connectionUrl(opts.target),
        allowlist: ctx.userConfig.allowlist(),
        fresh: opts.fresh ?? false,
        createSchema: opts.createSchema,
      });
      output(ctx, opts.json, result, (r) => printSync(ctx, r));
    });

  addSchemaCommands(ctx, program);
  addConfigCommands(ctx, program);
  addAiCommand(ctx, program);

  program
    .command("update")
    .description("install the latest version of tributary from npm, if there's a newer one")
    .action(async () => {
      const latest = await ctx.updates.fetchLatest();
      if (latest === undefined)
        throw new Error(
          "couldn't get the latest version from the npm registry (offline, or not published yet?)",
        );
      if (!semver.valid(latest) || !semver.gt(latest, version)) {
        ctx.stdout(`${packageName} ${version} is the latest version\n`);
        return;
      }
      const spec = `${packageName}@${latest}`;
      ctx.stderr(`${pc.dim(`running npm install -g ${spec}`)}\n`);
      await ctx.updates.install(spec);
      ctx.stdout(`updated ${packageName} ${version} → ${latest}\n`);
    });
  return program;
}

function addSchemaCommands(ctx: ProgramContext, program: Command): void {
  const schema = program
    .command("schema")
    .description("create and check schema files (app-level relations)");

  schema
    .command("init")
    .description(
      "write a starting schema file from the source database: every table, and its *_id columns to fill in",
    )
    .addOption(sourceOption())
    .option("-o, --output <file>", "where to write it", "./schema.yaml")
    .addOption(
      new Option("--format <format>", "file format").choices(["yaml", "json"]).default("yaml"),
    )
    .option("--force", "overwrite an existing file")
    .action(
      async (opts: {
        source: string;
        output: string;
        format: "yaml" | "json";
        force?: boolean;
      }) => {
        const path = resolve(ctx.cwd, opts.output);
        let overwrite = opts.force ?? false;
        if (!overwrite && existsSync(path)) {
          if (!ctx.confirm) {
            throw new Error(`${opts.output} already exists; pass --force to overwrite it`);
          }
          if (!(await ctx.confirm(`${opts.output} already exists. Overwrite it?`))) {
            ctx.stdout(`kept ${opts.output}; nothing written\n`);
            return;
          }
          overwrite = true;
        }
        const template = schemaTemplate(await inspectSource(ctx, opts.source), {
          format: opts.format,
        });
        mkdirSync(dirname(path), { recursive: true });
        try {
          // Without an overwrite decision, "wx" fails rather than clobber a file that appeared meanwhile.
          writeFileSync(path, template.text, { flag: overwrite ? "w" : "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          throw new Error(`${opts.output} already exists; pass --force to overwrite it`);
        }
        ctx.stdout(
          `wrote ${opts.output}: ${template.tables} tables, ${template.candidates} *_id columns to fill in\n`,
        );
        if (opts.format === "json") {
          ctx.stderr(
            `${pc.dim("note: JSON can't hold comments, so the *_id columns to fill in are only listed in the YAML format")}\n`,
          );
        }
      },
    );

  schema
    .command("validate")
    .description(
      "check a schema file's format, and with --source that its tables and columns exist",
    )
    .addOption(schemaOption())
    .addOption(
      sourceOption("also check that every table and column exists in this connection's database"),
    )
    .action(async (opts: { schema?: string; source?: string }) => {
      const found = findSchemaFile(ctx.cwd, opts.schema);
      if (!found) {
        throw new Error(
          "no schema file: pass --schema <file> or create ./schema.yaml (tributary schema init)",
        );
      }
      let file: SchemaFile;
      try {
        file = await loadSchemaFile(found.path);
      } catch (e) {
        throw relabel(e, found);
      }
      if (opts.source) {
        const problems = checkSchemaFile(await inspectSource(ctx, opts.source), file);
        if (problems.length) throw new SchemaFileError(problems, found.shown);
      }
      ctx.stdout(`${found.shown}: valid\n`);
    });
}

function addConfigCommands(ctx: ProgramContext, program: Command): void {
  const config = program
    .command("config")
    .description("manage local settings (connections, allowlist, AI)");
  config
    .command("set <key> <value>")
    .description("set a value, e.g. connections.prod.url, allowlist (comma-separated), ai.provider")
    .action((key: string, value: string) => ctx.userConfig.set(key, value));
  config.command("get <key>").action((key: string) => {
    const value = ctx.userConfig.get(key);
    if (value !== undefined)
      ctx.stdout(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  });
  config.command("unset <key>").action((key: string) => ctx.userConfig.unset(key));
  config
    .command("list")
    .description("print every setting (secrets included, unmasked)")
    .action(() => ctx.stdout(`${JSON.stringify(ctx.userConfig.all(), null, 2)}\n`));
  config
    .command("path")
    .description("print where settings are stored")
    .action(() => ctx.stdout(`${ctx.userConfig.path}\n`));
}

function addAiCommand(ctx: ProgramContext, program: Command): void {
  program
    .command("ai")
    .description("describe what you want in plain language; tributary picks the command")
    .argument("<request...>", 'e.g. "copy the user admin@example.com and their orders"')
    .addOption(sourceOption())
    .option("-T, --target <name>", "target connection name, needed for a generated sync")
    .addOption(schemaOption())
    .option("-y, --yes", "run a generated sync without asking")
    .option("--dry-run", "only show the generated command")
    .action(
      async (
        words: string[],
        opts: { source: string; target?: string; schema?: string; yes?: boolean; dryRun?: boolean },
      ) => {
        const spinner = p.spinner({ output: process.stderr });
        spinner.start("Reading the source schema");
        let command: Awaited<ReturnType<typeof generateCommand>>;
        try {
          const db = await inspectSource(ctx, opts.source);
          spinner.message("Asking the model");
          command = await generateCommand(
            createModel(ctx.userConfig.all().ai),
            words.join(" "),
            db,
            {
              canSync: opts.target !== undefined,
            },
          );
        } finally {
          spinner.stop();
        }

        const args = toCliArgs(command, opts);
        const warnings = command.warnings.map((w) => pc.yellow(`! ${w}`)).join("\n");
        p.note(
          [
            `tributary ${args.map(shellQuote).join(" ")}`,
            "",
            command.explanation,
            ...(warnings ? ["", warnings] : []),
          ].join("\n"),
          "Generated command",
          { output: process.stderr },
        );
        if (opts.dryRun) return;
        if (command.command === "sync" && !opts.yes) {
          if (!ctx.confirm)
            throw new Error(
              "not at a terminal, so nobody can confirm the sync: pass --yes to run it",
            );
          if (!(await ctx.confirm("This writes to the target database. Run it?"))) {
            p.cancel("Not run.");
            return;
          }
        }
        await createProgram(ctx).parseAsync(args, { from: "user" });
      },
    );
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function cliTable(head: string[]): Table.Table {
  return new Table({ head: head.map((h) => pc.bold(h)), style: { head: [], border: [] } });
}

function printWarnings(ctx: ProgramContext, warnings: string[]): void {
  for (const w of warnings) ctx.stderr(`${pc.yellow("warning:")} ${w}\n`);
}

function printPlan(ctx: ProgramContext, result: PlanResult): void {
  const t = cliTable(["table", "rows", "via"]);
  for (const row of result.tables) {
    const note = row.break
      ? pc.dim(
          row.break.auto
            ? " (cycle auto-broken; add it to breakCycle in the schema file to control this)"
            : " (breakCycle applied)",
        )
      : "";
    t.push([row.table, String(row.rows), row.via + note]);
  }
  ctx.stdout(
    `${t.toString()}\n\ntotal: ${result.totalRows} rows across ${result.tables.length} tables\n`,
  );
  printWarnings(ctx, result.warnings);
}

function printSync(ctx: ProgramContext, result: SyncResult): void {
  const t = cliTable(["table", "upserted", "backfilled", "left null", "status"]);
  for (const row of result.tables) {
    t.push([
      row.table,
      String(row.rowsUpserted),
      String(row.rowsBackfilled),
      String(row.rowsLeftNull),
      row.resumed ? pc.dim("already loaded (resumed)") : pc.green("loaded"),
    ]);
  }
  const created = result.schema.tablesCreated.length
    ? `created ${result.schema.tablesCreated.length} table(s) on target: ${result.schema.tablesCreated.join(", ")}\n`
    : "";
  ctx.stdout(
    `${t.toString()}\n\n${created}total: ${result.totalRows} rows upserted across ${result.tables.length} tables (run ${result.runId})\n`,
  );
  printWarnings(ctx, result.warnings);
}

/** Runs the CLI, printing errors readably and returning the exit code. */
export async function run(argv: string[], ctx?: Partial<ProgramContext>): Promise<number> {
  const confirm = terminalConfirm();
  const spinner = terminalProgress();
  const context: ProgramContext = {
    cwd: process.cwd(),
    userConfig: openUserConfig(),
    // Anything printed ends the spinner first, so its line never garbles output.
    stdout: (s) => {
      spinner?.stop();
      process.stdout.write(s);
    },
    stderr: (s) => {
      spinner?.stop();
      process.stderr.write(s);
    },
    updates: npmUpdateSource(packageName),
    ...(confirm && { confirm }),
    ...(spinner && { progress: spinner.update }),
    ...ctx,
  };
  // Runs alongside the command, so it only adds time when the command finishes first.
  const update = argv[0] === "update" ? undefined : startUpdateCheck(context);
  let code: number;
  try {
    await createProgram(context).parseAsync(argv, { from: "user" });
    code = 0;
  } catch (e) {
    spinner?.stop();
    const err = e as { code?: string; exitCode?: number };
    // Commander has already printed its own usage errors.
    if (err.code?.startsWith("commander.")) code = err.exitCode ?? 1;
    else {
      context.stderr(`${pc.red("error:")} ${e instanceof Error ? e.message : String(e)}\n`);
      code = 1;
    }
  }
  spinner?.stop();
  const available = await update;
  if (available) {
    context.stderr(
      `\n${pc.yellow(`Update available: ${available.current} → ${available.latest}. Run: tributary update`)}\n`,
    );
  }
  return code;
}

/** Starts the update check unless turned off (updates.check false, or TRIBUTARY_NO_UPDATE_CHECK). */
function startUpdateCheck(ctx: ProgramContext): Promise<AvailableUpdate | undefined> | undefined {
  if (process.env.TRIBUTARY_NO_UPDATE_CHECK) return undefined;
  if (ctx.userConfig.all().updates?.check === false) return undefined;
  return checkForUpdate({
    current: version,
    cachePath: join(dirname(ctx.userConfig.path), "update-check.json"),
    intervalMs: CHECK_INTERVAL_MS,
    fetchLatest: () => ctx.updates.fetchLatest(),
  });
}
