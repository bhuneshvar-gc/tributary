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
import type { LanguageModel } from "ai";
import Table from "cli-table3";
import { Command, Option } from "commander";
import pc from "picocolors";
import semver from "semver";
import {
  type AiCommand,
  createModel,
  type GeneratedCommand,
  generateCommand,
  type Turn,
  toCliArgs,
} from "./ai.js";
import { describeProgress, formatDuration, liveProgress } from "./progress.js";
import { findSchemaFile, loadRunSchema, relabel } from "./schema-file.js";
import {
  type AvailableUpdate,
  CHECK_INTERVAL_MS,
  checkForUpdate,
  npmUpdateSource,
  type UpdateSource,
} from "./update-check.js";
import { openUserConfig, type UserConfig, type UserConfigStore } from "./user-config.js";

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
  /** Picks one of `choices` (by value); undefined if cancelled. Absent like `confirm`. */
  choose?: (
    message: string,
    choices: { value: string; label: string }[],
  ) => Promise<string | undefined>;
  /** Asks for a line of text; undefined if cancelled. Absent like `confirm`. */
  ask?: (message: string) => Promise<string | undefined>;
  /** The AI model for `tributary ai` (default: the one configured with ai.*). */
  model?: (ai: UserConfig["ai"]) => LanguageModel;
  /** Where new versions are looked up and installed from. */
  updates: UpdateSource;
  /**
   * Shows what a long command is doing; absent when stderr isn't a
   * terminal. Messages with the same `step` update one line; a new step
   * closes the previous one as done (default: each message is its own step).
   */
  progress?: (message: string, step?: string) => void;
}

/** Yes/no, menu and text prompts on the terminal, or undefined when stdin/stderr aren't one. */
function terminalPrompts(): Pick<ProgramContext, "confirm" | "choose" | "ask"> | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return {
    async confirm(message) {
      const answer = await p.confirm({ message, initialValue: false, output: process.stderr });
      return !p.isCancel(answer) && answer;
    },
    async choose(message, choices) {
      const answer = await p.select({ message, options: choices, output: process.stderr });
      return p.isCancel(answer) ? undefined : String(answer);
    },
    async ask(message) {
      const answer = await p.text({ message, output: process.stderr });
      return p.isCancel(answer) ? undefined : answer;
    },
  };
}

interface SubsetCommandOptions {
  source: string;
  schema?: string;
  traversal?: Traversal;
  strictCycles?: boolean;
  json?: boolean;
}

interface SyncCommandOptions extends SubsetCommandOptions {
  target: string;
  fresh?: boolean;
  createSchema: boolean;
}

/** One --seed-table and the --where values written right after it, in command-line order. */
interface SeedFlag {
  table?: string;
  where: string[];
}

/** Each subset command's seed flags, recorded in order as commander parses them. */
const seedFlagsOf = new WeakMap<Command, SeedFlag[]>();

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
  // -t and -w are recorded in one list, so each -w belongs to the -t
  // written just before it, and a -t without one takes the whole table.
  const flags: SeedFlag[] = [];
  seedFlagsOf.set(cmd, flags);
  return cmd
    .addOption(sourceOption())
    .addOption(schemaOption())
    .option(
      "-t, --seed-table <table>",
      'seed table, e.g. "users" or "billing.invoices" (repeatable; no --where = every row)',
      (table: string) => {
        flags.push({ table, where: [] });
        return table;
      },
    )
    .option(
      "-w, --where <sql>",
      'WHERE fragment for the --seed-table just before it, e.g. "id = 42"',
      (where: string) => {
        const last = flags.at(-1);
        if (last) last.where.push(where);
        else flags.push({ where: [where] });
        return where;
      },
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
 * The seeds from the command line, in order. Each --where filters the
 * --seed-table just before it; a --seed-table without one takes every
 * row. Bare table names resolve in the schema file's defaultSchema, as in
 * the file.
 */
/** The flag's --where, or undefined when it's missing or blank (every row). */
function givenWhere(flag: SeedFlag): string | undefined {
  const where = flag.where[0];
  return where?.trim() ? where : undefined;
}

function seeds(flags: SeedFlag[], defaultSchema: string): Seed[] {
  if (flags.length === 0) {
    throw new Error("no seed: pass --seed-table <table> [--where <sql>] (repeat for more)");
  }
  return flags.map((flag) => {
    if (flag.table === undefined) {
      throw new Error("--where must come right after the --seed-table it filters");
    }
    const table = qualifyTable(flag.table, defaultSchema);
    if (flag.where.length > 1) {
      throw new Error(`${table} already has a --where; combine them with AND in one --where`);
    }
    return { table, where: givenWhere(flag) ?? "true" };
  });
}

/** Everything a plan or sync needs from the command line, resolved. */
async function subset(ctx: ProgramContext, opts: SubsetCommandOptions, cmd: Command) {
  const source = ctx.userConfig.connectionUrl(opts.source);
  const flags = seedFlagsOf.get(cmd) ?? [];
  seeds(flags, "public"); // usage errors before any file or database work
  const schema = await loadRunSchema(ctx.cwd, opts.schema, (m) => ctx.stderr(`${pc.dim(m)}\n`));
  const seedList = seeds(flags, schema?.defaultSchema ?? "public");
  for (const seed of seedList.filter((_, i) => givenWhere(flags[i]!) === undefined)) {
    ctx.stderr(`${pc.dim(`no --where for ${seed.table}: taking every row`)}\n`);
  }
  return {
    source,
    seeds: seedList,
    ...(schema && { schema }),
    ...(opts.traversal && { traversal: opts.traversal }),
    ...(opts.strictCycles && { strictCycles: true }),
    ...(ctx.progress && {
      onProgress: (event: SubsetProgress) => {
        const { text, step } = describeProgress(event);
        ctx.progress?.(text, step);
      },
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
    .action(async (opts: SubsetCommandOptions, cmd: Command) => {
      output(ctx, opts.json, await plan(await subset(ctx, opts, cmd)), (r) => printPlan(ctx, r));
    });

  subsetOptions(program.command("sync"))
    .description("copy the subset from source into target (upserting; safe to re-run)")
    .requiredOption("-T, --target <name>", "target connection name")
    .option("--fresh", "delete the subset's rows from target before loading them")
    .option("--no-create-schema", "fail instead of creating missing target tables")
    .action(async (opts: SyncCommandOptions, cmd: Command) => {
      const result = await sync({
        ...(await subset(ctx, opts, cmd)),
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
        ctx.progress?.("reading the source schema");
        const db = await inspectSource(ctx, opts.source);
        const ai = ctx.userConfig.all().ai;
        const model = (ctx.model ?? createModel)(ai);
        const history: Turn[] = [];
        let request = words.join(" ");

        // Generate, show, then run / follow up / cancel, until run or cancel.
        for (;;) {
          ctx.progress?.("asking the model", "ask");
          const { command, usage } = await generateCommand(model, request, db, {
            canSync: opts.target !== undefined,
            history,
            onStep: ({ step, tools }) =>
              ctx.progress?.(
                `asking the model: step ${step} done (${tools.join(", ") || "no tool"})`,
                "ask",
              ),
            ...(ai?.maxPromptTokens && { maxPromptTokens: ai.maxPromptTokens }),
          });
          const args = toCliArgs(command, opts);
          printGenerated(ctx, args, command, usage);
          if (opts.dryRun) return;

          if (!opts.yes) {
            if (!ctx.choose) {
              // No terminal: read-only commands run as before; a sync needs --yes.
              if (command.command === "sync") {
                throw new Error(
                  "not at a terminal, so nobody can confirm the sync: pass --yes to run it",
                );
              }
            } else {
              const next = await nextStep(ctx, command);
              if (next.kind === "follow-up") {
                history.push({ request, command });
                request = next.change;
                continue;
              }
              if (next.kind === "cancel") {
                ctx.stderr("Not run.\n");
                return;
              }
            }
          }
          await createProgram(ctx).parseAsync(args, { from: "user" });
          return;
        }
      },
    );
}

/**
 * Asks what to do with a generated command until the answer is final: an
 * empty follow-up just asks again, without another model call.
 */
async function nextStep(
  ctx: ProgramContext,
  command: AiCommand,
): Promise<{ kind: "run" } | { kind: "cancel" } | { kind: "follow-up"; change: string }> {
  const choices = [
    {
      value: "run",
      label: command.command === "sync" ? "Run it (writes to the target database)" : "Run it",
    },
    { value: "follow-up", label: "Follow up: change something" },
    { value: "cancel", label: "Cancel" },
  ];
  for (;;) {
    const next = await ctx.choose!("What next?", choices);
    if (next === "run") return { kind: "run" };
    if (next !== "follow-up") return { kind: "cancel" };
    const change = (await ctx.ask?.("What should change?"))?.trim();
    if (change) return { kind: "follow-up", change };
  }
}

/** Shows a generated command, the model's explanation and warnings, and the tokens it took. */
function printGenerated(
  ctx: ProgramContext,
  args: string[],
  command: AiCommand,
  usage: GeneratedCommand["usage"],
): void {
  const lines = [
    pc.bold("Generated command"),
    `  tributary ${args.map(shellQuote).join(" ")}`,
    "",
    `  ${command.explanation}`,
    ...command.warnings.map((w) => pc.yellow(`  ! ${w}`)),
    pc.dim(
      `  ai: ${usage.inputTokens.toLocaleString("en-US")} tokens in, ${usage.outputTokens.toLocaleString("en-US")} out, ${usage.steps} step${usage.steps === 1 ? "" : "s"}`,
    ),
  ];
  ctx.stderr(`\n${lines.join("\n")}\n\n`);
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
    `${t.toString()}\n\ntotal: ${result.totalRows.toLocaleString("en-US")} rows across ${result.tables.length} tables, in ${formatDuration(result.durationMs)}\n`,
  );
  printWarnings(ctx, result.warnings);
}

function printSync(ctx: ProgramContext, result: SyncResult): void {
  const t = cliTable(["table", "loaded as", "written", "unchanged", "backfilled", "left null"]);
  for (const row of result.tables) {
    t.push([
      row.table,
      row.mode,
      String(row.rowsWritten),
      row.rowsUnchanged ? pc.dim(String(row.rowsUnchanged)) : "0",
      String(row.rowsBackfilled),
      String(row.rowsLeftNull),
    ]);
  }
  const created = result.schema.tablesCreated.length
    ? `created ${result.schema.tablesCreated.length} table(s) on target: ${result.schema.tablesCreated.join(", ")}\n`
    : "";
  const unchanged = result.tables.reduce((n, r) => n + r.rowsUnchanged, 0);
  ctx.stdout(
    `${t.toString()}\n\n${created}total: ${result.totalRows.toLocaleString("en-US")} rows written, ${unchanged.toLocaleString("en-US")} unchanged across ${result.tables.length} tables, in ${formatDuration(result.durationMs)} (run ${result.runId})\n`,
  );
  printWarnings(ctx, result.warnings);
}

/** Runs the CLI, printing errors readably and returning the exit code. */
export async function run(argv: string[], ctx?: Partial<ProgramContext>): Promise<number> {
  const prompts = terminalPrompts();
  const live = process.stderr.isTTY ? liveProgress(process.stderr) : undefined;
  const context: ProgramContext = {
    cwd: process.cwd(),
    userConfig: openUserConfig(),
    // Anything printed closes the step in progress first, so its live line never garbles output.
    stdout: (s) => {
      live?.finish();
      process.stdout.write(s);
    },
    stderr: (s) => {
      live?.finish();
      process.stderr.write(s);
    },
    updates: npmUpdateSource(packageName),
    ...prompts,
    ...(live && { progress: live.update }),
    ...ctx,
  };
  // Runs alongside the command, so it only adds time when the command finishes first.
  const update = argv[0] === "update" ? undefined : startUpdateCheck(context);
  let code: number;
  try {
    await createProgram(context).parseAsync(argv, { from: "user" });
    code = 0;
  } catch (e) {
    live?.fail();
    const err = e as { code?: string; exitCode?: number };
    // Commander has already printed its own usage errors.
    if (err.code?.startsWith("commander.")) code = err.exitCode ?? 1;
    else {
      context.stderr(`${pc.red("error:")} ${e instanceof Error ? e.message : String(e)}\n`);
      code = 1;
    }
  }
  live?.finish();
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
