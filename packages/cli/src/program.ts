import {
  inspect,
  type PlanResult,
  type ProjectConfig,
  plan,
  qualifyTable,
  type Seed,
  type SyncResult,
  sync,
} from "@bhuneshvar-k/tributary-core";
import * as p from "@clack/prompts";
import Table from "cli-table3";
import { Command, Option } from "commander";
import pc from "picocolors";
import { createModel, generateCommand, toCliArgs } from "./ai.js";
import { loadProjectConfig } from "./project-config.js";
import { openUserConfig, type UserConfigStore } from "./user-config.js";

export interface ProgramContext {
  cwd: string;
  userConfig: UserConfigStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ProjectOptions {
  config?: string;
  source?: string;
}

interface SeedOptions extends ProjectOptions {
  seedTable?: string;
  where?: string;
  traversal?: "downstream" | "full";
  strictCycles?: boolean;
  json?: boolean;
}

interface SyncOptions extends SeedOptions {
  target?: string;
  fresh?: boolean;
  createSchema: boolean;
}

function projectOptions(cmd: Command): Command {
  return cmd
    .option(
      "-c, --config <path>",
      "project config file (default: ./tributary.config.*)",
    )
    .option(
      "-s, --source <name>",
      "source connection name (overrides the project config)",
    );
}

function seedOptions(cmd: Command): Command {
  return projectOptions(cmd)
    .option(
      "-t, --seed-table <table>",
      'seed table, e.g. "users" or "billing.invoices"',
    )
    .option(
      "-w, --where <sql>",
      'raw SQL WHERE fragment selecting seed rows, e.g. "id = 42"',
    )
    .addOption(
      new Option(
        "--traversal <mode>",
        "fan out from every row, not just the seed's downstream",
      ).choices(["downstream", "full"]),
    )
    .option(
      "--strict-cycles",
      "fail on a foreign key cycle with no dependency break",
    )
    .option("--json", "print JSON");
}

async function resolveProject(ctx: ProgramContext, opts: SeedOptions) {
  const { config } = await loadProjectConfig(ctx.cwd, opts.config);
  const merged: ProjectConfig = {
    ...config,
    ...(opts.traversal && { traversal: opts.traversal }),
    ...(opts.strictCycles && { strictCycles: true }),
  };
  const sourceName = opts.source ?? config.source;
  if (!sourceName) {
    throw new Error(
      "no source connection: pass --source <name> or set `source` in tributary.config.ts",
    );
  }
  return {
    config: merged,
    sourceUrl: ctx.userConfig.connectionUrl(sourceName),
  };
}

function resolveSeed(config: ProjectConfig, opts: SeedOptions): Seed {
  const table = opts.seedTable
    ? qualifyTable(opts.seedTable)
    : config.seed?.table;
  const where = opts.where ?? config.seed?.where;
  if (!table || !where) {
    throw new Error(
      "no seed: pass --seed-table and --where, or set `seed` in tributary.config.ts",
    );
  }
  return { table, where };
}

export function createProgram(ctx: ProgramContext): Command {
  const program = new Command("tributary")
    .description("Copy referentially-consistent subsets of a Postgres database")
    .version("0.1.0")
    .showHelpAfterError()
    .configureOutput({ writeOut: ctx.stdout, writeErr: ctx.stderr });

  projectOptions(program.command("inspect"))
    .description("print the source schema (tables, columns, keys) as JSON")
    .action(async (opts: ProjectOptions) => {
      const { sourceUrl } = await resolveProject(ctx, opts);
      ctx.stdout(`${JSON.stringify(await inspect(sourceUrl), null, 2)}\n`);
    });

  seedOptions(program.command("plan"))
    .description(
      "compute the subset and report row counts per table, writing nothing",
    )
    .action(async (opts: SeedOptions) => {
      const { config, sourceUrl } = await resolveProject(ctx, opts);
      const result = await plan({
        source: sourceUrl,
        seed: resolveSeed(config, opts),
        config,
      });
      if (opts.json) ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
      else printPlan(ctx, result);
    });

  seedOptions(program.command("sync"))
    .description(
      "copy the subset from source into target (upserting; safe to re-run)",
    )
    .option(
      "-T, --target <name>",
      "target connection name (overrides the project config)",
    )
    .option(
      "--fresh",
      "delete the subset's rows from target first, and don't resume an earlier run",
    )
    .option(
      "--no-create-schema",
      "fail instead of creating missing target tables",
    )
    .action(async (opts: SyncOptions) => {
      const { config, sourceUrl } = await resolveProject(ctx, opts);
      const targetName = opts.target ?? config.target;
      if (!targetName) {
        throw new Error(
          "no target connection: pass --target <name> or set `target` in tributary.config.ts",
        );
      }
      const result = await sync({
        source: sourceUrl,
        target: ctx.userConfig.connectionUrl(targetName),
        seed: resolveSeed(config, opts),
        config,
        allowlist: ctx.userConfig.allowlist(),
        fresh: opts.fresh ?? false,
        createSchema: opts.createSchema,
      });
      if (opts.json) ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
      else printSync(ctx, result);
    });

  const config = program
    .command("config")
    .description("manage local settings (connections, allowlist, AI)");
  config
    .command("set <key> <value>")
    .description(
      "set a value, e.g. connections.prod.url, allowlist (comma-separated), ai.provider",
    )
    .action((key: string, value: string) => ctx.userConfig.set(key, value));
  config.command("get <key>").action((key: string) => {
    const value = ctx.userConfig.get(key);
    if (value !== undefined)
      ctx.stdout(
        `${typeof value === "string" ? value : JSON.stringify(value)}\n`,
      );
  });
  config
    .command("unset <key>")
    .action((key: string) => ctx.userConfig.unset(key));
  config
    .command("list")
    .description("print every setting (secrets included, unmasked)")
    .action(() =>
      ctx.stdout(`${JSON.stringify(ctx.userConfig.all(), null, 2)}\n`),
    );
  config
    .command("path")
    .description("print where settings are stored")
    .action(() => ctx.stdout(`${ctx.userConfig.path}\n`));

  projectOptions(program.command("ai"))
    .description(
      "describe what you want in plain language; tributary picks the command",
    )
    .argument(
      "<request...>",
      'e.g. "copy the user admin@example.com and their orders"',
    )
    .option(
      "-T, --target <name>",
      "target connection name, for a generated sync",
    )
    .option("-y, --yes", "run a generated sync without asking")
    .option("--dry-run", "only show the generated command")
    .action(
      async (
        words: string[],
        opts: ProjectOptions & {
          target?: string;
          yes?: boolean;
          dryRun?: boolean;
        },
      ) => {
        const { sourceUrl } = await resolveProject(ctx, opts);
        const spinner = p.spinner({ output: process.stderr });
        spinner.start("Reading the source schema");
        const schema = await inspect(sourceUrl);
        spinner.message("Asking the model");
        const command = await generateCommand(
          createModel(ctx.userConfig.all().ai),
          words.join(" "),
          schema,
        ).finally(() => spinner.stop());

        const args = toCliArgs(command);
        for (const [flag, value] of [
          ["--config", opts.config],
          ["--source", opts.source],
          ["--target", command.command === "sync" ? opts.target : undefined],
        ] as const) {
          if (value) args.push(flag, value);
        }
        const warnings = command.warnings
          .map((w) => pc.yellow(`! ${w}`))
          .join("\n");
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
          const ok = await p.confirm({
            message: "This writes to the target database. Run it?",
            initialValue: false,
            output: process.stderr,
          });
          if (p.isCancel(ok) || !ok) {
            p.cancel("Not run.");
            return;
          }
        }
        await createProgram(ctx).parseAsync(args, { from: "user" });
      },
    );

  return program;
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", "'\\''")}'`;
}

function table(head: string[]): Table.Table {
  return new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
}

function printWarnings(ctx: ProgramContext, warnings: string[]): void {
  for (const w of warnings) ctx.stderr(`${pc.yellow("warning:")} ${w}\n`);
}

function printPlan(ctx: ProgramContext, result: PlanResult): void {
  const t = table(["table", "rows", "via"]);
  for (const row of result.tables) {
    const note = row.break
      ? pc.dim(
          row.break.auto
            ? " (cycle auto-broken; add a dependencyBreaks entry to control this)"
            : " (dependency break applied)",
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
  const t = table(["table", "upserted", "backfilled", "left null", "status"]);
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
export async function run(
  argv: string[],
  ctx?: Partial<ProgramContext>,
): Promise<number> {
  const context: ProgramContext = {
    cwd: process.cwd(),
    userConfig: openUserConfig(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    ...ctx,
  };
  const program = createProgram(context).exitOverride();
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    const err = e as { code?: string; exitCode?: number };
    if (err.code?.startsWith("commander.")) return err.exitCode ?? 1;
    context.stderr(
      `${pc.red("error:")} ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}
