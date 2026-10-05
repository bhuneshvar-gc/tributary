import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Schema } from "@bhuneshvar-k/tributary-core";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import type { AiProvider, UserConfig } from "./user-config.js";

/**
 * What the model must return. Optional fields are nullable rather than
 * omittable, since strict structured-output modes require every key.
 */
export const aiCommandSchema = z
  .object({
    command: z.enum(["inspect", "plan", "sync"]),
    seedTable: z
      .string()
      .nullish()
      .describe("Seed table, unqualified unless the user names a schema"),
    where: z
      .string()
      .nullish()
      .describe("Raw SQL WHERE fragment selecting the seed rows"),
    traversal: z.enum(["downstream", "full"]).nullish(),
    fresh: z.boolean().nullish(),
    explanation: z
      .string()
      .describe("One or two sentences on what the command does"),
    warnings: z.array(z.string()).describe("Assumptions made and caveats"),
  })
  .superRefine((c, ctx) => {
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

/** The equivalent `tributary ...` arguments, leaving defaults off. */
export function toCliArgs(c: AiCommand): string[] {
  const args: string[] = [c.command];
  if (c.command === "inspect") return args;
  args.push("--seed-table", c.seedTable!, "--where", c.where!);
  if (c.traversal === "full") args.push("--traversal", "full");
  if (c.command === "sync" && c.fresh) args.push("--fresh");
  return args;
}

export function buildSystemPrompt(schema?: Schema): string {
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
    "Rules:",
    '- plan and sync need seedTable and where. where is a raw SQL WHERE fragment, e.g. "id = 42".',
    "- Use unqualified table names unless the user names a schema.",
    '- "sync", "copy", "load" or "migrate" means sync; "preview", "how many" or "what would" means plan.',
    '- traversal "full" also fans out from parent rows (e.g. a user\'s whole company). Only use it',
    "  if the user asks for related data beyond the seed's own. Otherwise leave it null.",
    "- fresh deletes previously loaded subset rows first. Only set it if the user asks for a clean reload.",
    "- Only use tables and columns from the schema below. If the user's table or column doesn't",
    "  exist, pick the closest match and say so in warnings.",
    "- If the request is ambiguous, pick the most likely intent and state the assumption in warnings.",
  ];

  if (schema?.tables.length) {
    lines.push("", "Database schema:");
    for (const t of schema.tables) {
      const pk = t.primaryKey.length
        ? ` (primary key: ${t.primaryKey.join(", ")})`
        : " (no primary key)";
      lines.push(`${t.schema}.${t.name}${pk}`);
      for (const c of t.columns)
        lines.push(
          `  - ${c.name}: ${c.sqlType}${c.nullable ? ", nullable" : ""}`,
        );
      for (const fk of t.foreignKeys) {
        lines.push(
          `  references: ${fk.fromColumns.join(", ")} -> ${fk.toTable}.${fk.toColumns.join(", ")}`,
        );
      }
    }
    const enums = Object.entries(schema.enums);
    if (enums.length) {
      lines.push("", "Enum types:");
      for (const [name, labels] of enums)
        lines.push(`  ${name}: ${labels.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const DEFAULT_MODELS: Partial<Record<AiProvider, string>> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
};

/**
 * The configured model. API keys fall back to each provider's usual
 * environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
 */
export function createModel(ai: UserConfig["ai"] = {}): LanguageModel {
  const provider = ai.provider ?? "anthropic";
  const model = ai.model ?? DEFAULT_MODELS[provider];
  if (!model) {
    throw new Error(
      `set a model for ${provider}: tributary config set ai.model <model-id>`,
    );
  }
  const apiKey = ai.apiKey;
  const baseURL = ai.baseUrl;
  const opts = { ...(apiKey && { apiKey }), ...(baseURL && { baseURL }) };
  switch (provider) {
    case "anthropic":
      return createAnthropic(opts)(model);
    case "openai":
      return createOpenAI(opts)(model);
    case "google":
      return createGoogleGenerativeAI(opts)(model);
    case "openrouter":
      return createOpenRouter({
        ...opts,
        headers: {
          "HTTP-Referer": "https://github.com/bhuneshvar-k/tributary",
          "X-Title": "Tributary",
        },
      })(model);
    case "opencode":
      return createOpenAICompatible({
        name: "opencode",
        baseURL: baseURL ?? "http://localhost:11434/v1",
        ...(apiKey && { apiKey }),
      })(model);
  }
}

/** Asks the model to turn a natural-language request into a command. */
export async function generateCommand(
  model: LanguageModel,
  request: string,
  schema?: Schema,
): Promise<AiCommand> {
  const { output } = await generateText({
    model,
    system: buildSystemPrompt(schema),
    prompt: request,
    output: Output.object({ schema: aiCommandSchema }),
    maxRetries: 3,
  });
  return parseAiCommand(output);
}
