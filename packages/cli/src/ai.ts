import { type Schema, TRAVERSALS } from "@bhuneshvar-k/tributary-core";
import { generateText, type LanguageModel, type ModelMessage, stepCountIs, tool } from "ai";
import { z } from "zod";
import { PROVIDERS, type ProviderSpec } from "./providers.js";
import { schemaTools } from "./schema-tools.js";
import type { UserConfig } from "./user-config.js";

/**
 * The command the model submits. Optional fields are nullable rather than
 * omittable, since strict tool-input modes require every key.
 */
const commandFields = z.object({
  command: z.enum(["inspect", "plan", "sync"]),
  seedTable: z
    .string()
    .nullish()
    .describe("Seed table, unqualified unless the user names a schema"),
  where: z.string().nullish().describe("Raw SQL WHERE fragment selecting the seed rows"),
  traversal: z.enum(TRAVERSALS).nullish(),
  fresh: z.boolean().nullish(),
  explanation: z.string().describe("One or two sentences on what the command does"),
  warnings: z.array(z.string()).describe("Assumptions made and caveats"),
});

export const aiCommandSchema = commandFields.superRefine((c, ctx) => {
  if (c.command !== "inspect" && (!c.seedTable || !c.where)) {
    ctx.addIssue({
      code: "custom",
      message: `${c.command} needs a seed table and a where predicate`,
    });
  }
});

export type AiCommand = z.output<typeof aiCommandSchema>;

export function parseAiCommand(input: unknown): AiCommand {
  const result = aiCommandSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `the model returned an invalid command: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

/** Where a generated command runs: the user's own --source/--target/--schema. */
export interface CommandContext {
  source: string;
  target?: string;
  schema?: string;
}

/** The equivalent `tributary ...` arguments, leaving defaults off. */
export function toCliArgs(c: AiCommand, ctx: CommandContext): string[] {
  if (c.command === "inspect") return ["inspect", "--source", ctx.source];
  const args = [c.command, "--seed-table", c.seedTable!, "--where", c.where!];
  if (c.traversal === "full") args.push("--traversal", "full");
  if (c.command === "sync" && c.fresh) args.push("--fresh");
  if (ctx.schema) args.push("--schema", ctx.schema);
  args.push("--source", ctx.source);
  if (c.command === "sync") {
    if (!ctx.target) throw new Error("the model asked for a sync, but no --target was given");
    args.push("--target", ctx.target);
  }
  return args;
}

export function buildSystemPrompt(options: { canSync?: boolean } = {}): string {
  const lines = [
    "You are Tributary AI. Tributary copies referentially-consistent subsets of a Postgres",
    "database: starting from seed rows, it follows foreign keys to every row that must travel",
    "with them. Translate the user's request into exactly one Tributary command.",
    "",
    "Commands:",
    '- "inspect": show the source schema. Takes no seed.',
    '- "plan": preview a subset (row counts per table) without writing anything.',
    '- "sync": copy the subset into the target database.',
    "",
    "Finding tables (the schema is not included here; look up only what you need):",
    "- search_tables(query): tables whose name or columns match the words in query.",
    "- describe_table(table): one table's primary key, columns and foreign keys.",
    "- list_schemas(): every schema with its table count.",
    "- Many schemas can hold identical copies of a table (one per tenant). If the user names a",
    "  tenant or schema, use that schema; otherwise ask for it in warnings and pick the likeliest.",
    "- Use as few lookups as you need, usually one search and one or two describes.",
    "",
    "Rules:",
    '- plan and sync need seedTable and where. where is a raw SQL WHERE fragment, e.g. "id = 42".',
    '- seedTable is "schema.table". Only use tables and columns you have looked up.',
    '- "sync", "copy", "load" or "migrate" means sync; "preview", "how many" or "what would" means plan.',
    '- traversal "full" also fans out from parent rows (e.g. a user\'s whole company). Only use it',
    "  if the user asks for related data beyond the seed's own. Otherwise leave it null.",
    "- fresh deletes previously loaded subset rows first. Only set it if the user asks for a clean reload.",
    "- If the request is ambiguous, pick the most likely intent and state the assumption in warnings.",
  ];
  if (options.canSync === false) {
    lines.push(
      '- "sync" is not available: no --target was given. Use "plan" instead, and say so in warnings.',
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The configured model; see PROVIDERS for what each provider needs. */
export function createModel(ai: UserConfig["ai"] = {}): LanguageModel {
  const provider = ai.provider ?? "anthropic";
  const spec: ProviderSpec = PROVIDERS[provider];
  const model = ai.model ?? spec.defaultModel;
  if (!model)
    throw new Error(`set a model for ${provider}: tributary config set ai.model <model-id>`);
  if (spec.needsBaseUrl && !ai.baseUrl) {
    throw new Error(`set the endpoint for ${provider}: tributary config set ai.baseUrl <url>`);
  }
  return spec.create(model, {
    ...(ai.apiKey && { apiKey: ai.apiKey }),
    ...(ai.baseUrl && { baseURL: ai.baseUrl }),
  });
}

/** Asks the model to turn a natural-language request into a command. */
/** Default for ai.maxPromptTokens: input tokens one `tributary ai` request may use in total. */
export const DEFAULT_MAX_PROMPT_TOKENS = 20_000;

/** At most this many model calls (lookups plus the answer) per request. */
const MAX_STEPS = 8;

/** One earlier round: what was asked and the command it produced. */
export interface Turn {
  request: string;
  command: AiCommand;
}

/**
 * The messages for a request after earlier rounds. Only requests and the
 * commands they produced are kept, not the lookups behind them, so a
 * follow-up costs about as much as the first request.
 */
function conversation(history: Turn[], request: string): ModelMessage[] {
  return [
    ...history.flatMap((turn): ModelMessage[] => [
      { role: "user", content: turn.request },
      { role: "assistant", content: `I submitted this command:\n${JSON.stringify(turn.command)}` },
    ]),
    { role: "user", content: request },
  ];
}

export interface GeneratedCommand {
  command: AiCommand;
  usage: { inputTokens: number; outputTokens: number; steps: number };
}

/**
 * Asks the model to turn a natural-language request into a command. The
 * model looks the schema up through tools instead of receiving all of it,
 * and the whole exchange stops once it has used `maxPromptTokens` input
 * tokens, so a large database can't make one request expensive.
 */
export async function generateCommand(
  model: LanguageModel,
  request: string,
  catalog: Schema,
  options: {
    canSync?: boolean;
    maxPromptTokens?: number;
    /** Earlier rounds of this conversation, oldest first, for a follow-up request. */
    history?: Turn[];
  } = {},
): Promise<GeneratedCommand> {
  const cap = options.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
  const lookups = schemaTools(catalog);
  const inputTokens = (steps: { usage: { inputTokens?: number | undefined } }[]) =>
    steps.reduce((n, s) => n + (s.usage.inputTokens ?? 0), 0);

  let submitted: AiCommand | undefined;
  const result = await generateText({
    model,
    system: buildSystemPrompt(options),
    messages: conversation(options.history ?? [], request),
    tools: {
      search_tables: tool({
        description: "Find tables whose name or columns match the words in query.",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => lookups.searchTables(query),
      }),
      describe_table: tool({
        description:
          'Primary key, columns and foreign keys of one table ("schema.table" or a bare name).',
        inputSchema: z.object({ table: z.string() }),
        execute: async ({ table }) => lookups.describeTable(table),
      }),
      list_schemas: tool({
        description: "Every schema with its number of tables.",
        inputSchema: z.object({}),
        execute: async () => lookups.listSchemas(),
      }),
      submit_command: tool({
        description:
          "Submit the final command once you know the table and predicate. Call this to finish.",
        inputSchema: commandFields,
        execute: async (input) => {
          try {
            submitted = parseAiCommand(input);
            return { accepted: true };
          } catch (e) {
            return { accepted: false, error: (e as Error).message };
          }
        },
      }),
    },
    // Every step is a tool call, so the model can't answer before looking
    // anything up; it finishes by submitting a valid command.
    toolChoice: "required",
    stopWhen: [
      () => submitted !== undefined,
      stepCountIs(MAX_STEPS),
      ({ steps }) => inputTokens(steps) >= cap,
    ],
    maxRetries: 3,
  });

  const usage = {
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
    steps: result.steps.length,
  };
  if (!submitted) {
    const why =
      usage.inputTokens >= cap
        ? `stopped at the token cap (${cap.toLocaleString("en-US")} input tokens) before it decided`
        : `stopped after ${MAX_STEPS} steps before it decided`;
    throw new Error(
      `the model ${why}; try a more specific request, or raise the cap with tributary config set ai.maxPromptTokens <n>`,
    );
  }
  return { command: submitted, usage };
}
