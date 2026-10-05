import type { Schema } from "@bhuneshvar-k/tributary-core";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  buildSystemPrompt,
  createModel,
  generateCommand,
  parseAiCommand,
  toCliArgs,
} from "../src/ai.js";

const schema: Schema = {
  tables: [
    {
      schema: "public",
      name: "users",
      primaryKey: ["id"],
      columns: [
        {
          name: "id",
          type: "integer",
          udtSchema: "pg_catalog",
          udtName: "int4",
          sqlType: "integer",
          nullable: false,
        },
        {
          name: "email",
          type: "text",
          udtSchema: "pg_catalog",
          udtName: "text",
          sqlType: "text",
          nullable: true,
        },
        {
          name: "company_id",
          type: "integer",
          udtSchema: "pg_catalog",
          udtName: "int4",
          sqlType: "integer",
          nullable: true,
        },
      ],
      foreignKeys: [
        {
          constraintName: "users_company_fk",
          fromTable: "public.users",
          fromColumns: ["company_id"],
          toTable: "public.companies",
          toColumns: ["id"],
        },
      ],
    },
  ],
  enums: { user_role: ["admin", "member"] },
};

describe("buildSystemPrompt", () => {
  test("describes the commands and the schema tools, without any schema in it", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"plan"');
    expect(prompt).toContain('"sync"');
    expect(prompt).toContain("search_tables");
    expect(prompt).toContain("describe_table");
    expect(prompt).not.toContain("public.users");
  });

  test("stays small however large the database is", () => {
    expect(buildSystemPrompt().length).toBeLessThan(4_000);
  });
});

describe("parseAiCommand", () => {
  test("a plan needs a seed table and predicate", () => {
    expect(() =>
      parseAiCommand({
        command: "plan",
        seedTable: "users",
        where: null,
        explanation: "x",
        warnings: [],
      }),
    ).toThrow(/plan needs a seed table and a where predicate/);
  });

  test("inspect needs no seed", () => {
    expect(
      parseAiCommand({
        command: "inspect",
        seedTable: null,
        where: null,
        explanation: "show schema",
        warnings: [],
      }),
    ).toMatchObject({ command: "inspect" });
  });

  test("an unknown command is rejected", () => {
    expect(() => parseAiCommand({ command: "drop", explanation: "", warnings: [] })).toThrow();
  });
});

describe("toCliArgs", () => {
  test("maps a sync command to the equivalent CLI invocation", () => {
    const command = parseAiCommand({
      command: "sync",
      seedTable: "users",
      where: "email = 'a@b.co'",
      traversal: "full",
      fresh: true,
      explanation: "copy that user",
      warnings: [],
    });
    expect(toCliArgs(command, { source: "prod", target: "local" })).toEqual([
      "sync",
      "--seed-table",
      "users",
      "--where",
      "email = 'a@b.co'",
      "--traversal",
      "full",
      "--fresh",
      "--source",
      "prod",
      "--target",
      "local",
    ]);
  });

  test("leaves defaults off", () => {
    const command = parseAiCommand({
      command: "plan",
      seedTable: "users",
      where: "id = 1",
      traversal: null,
      fresh: null,
      explanation: "",
      warnings: [],
    });
    expect(toCliArgs(command, { source: "prod" })).toEqual([
      "plan",
      "--seed-table",
      "users",
      "--where",
      "id = 1",
      "--source",
      "prod",
    ]);
  });
});

describe("createModel", () => {
  test("opencode needs an explicit base URL instead of guessing a port", () => {
    expect(() => createModel({ provider: "opencode", model: "m" })).toThrow(
      /tributary config set ai\.baseUrl/,
    );
  });

  test("a provider with no default model asks for one", () => {
    expect(() => createModel({ provider: "openrouter", apiKey: "k" })).toThrow(
      /tributary config set ai\.model/,
    );
  });

  test("defaults to Anthropic's model", () => {
    expect(createModel({ apiKey: "k" })).toMatchObject({ modelId: "claude-sonnet-5-5" });
  });
});

describe("sync availability", () => {
  test("without a target the model is told sync isn't available", () => {
    expect(buildSystemPrompt({ canSync: false })).toContain(
      '"sync" is not available: no --target was given. Use "plan" instead',
    );
    expect(buildSystemPrompt()).not.toContain("not available");
  });

  test("CLI args carry the source, schema file and target", () => {
    const command = parseAiCommand({
      command: "sync",
      seedTable: "users",
      where: "id = 1",
      explanation: "",
      warnings: [],
    });
    expect(toCliArgs(command, { source: "prod", target: "local", schema: "schema.yaml" })).toEqual([
      "sync",
      "--seed-table",
      "users",
      "--where",
      "id = 1",
      "--schema",
      "schema.yaml",
      "--source",
      "prod",
      "--target",
      "local",
    ]);
    expect(
      toCliArgs({ ...command, command: "inspect" }, { source: "prod", target: "local" }),
    ).toEqual(["inspect", "--source", "prod"]);
  });
});

describe("generateCommand", () => {
  const usage = (input: number, output = 20) => ({
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  });
  const toolCall = (id: string, toolName: string, input: object) => ({
    content: [
      { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: usage(1_000),
    warnings: [],
  });
  const submit = (id: string, command: object) => ({
    ...toolCall(id, "submit_command", command),
    usage: usage(1_500, 80),
  });
  const plan = {
    command: "plan",
    seedTable: "public.users",
    where: "email = 'a@b.co'",
    traversal: null,
    fresh: null,
    explanation: "preview that user",
    warnings: [],
  };

  test("the model looks tables up with tools, then answers; usage is summed", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("1", "search_tables", { query: "users" }), submit("2", plan)],
    });

    const result = await generateCommand(model, "preview the user a@b.co", schema);

    expect(result.command).toMatchObject({ command: "plan", seedTable: "public.users" });
    expect(result.usage).toEqual({ inputTokens: 2_500, outputTokens: 100, steps: 2 });
    const toolResult = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(toolResult).toContain("users");
    expect(toolResult).toContain('"schemas":["public"]');
  });

  test("an invalid submission is sent back as an error, and the corrected one is used", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [submit("1", { ...plan, seedTable: null, where: null }), submit("2", plan)],
    });

    const result = await generateCommand(model, "preview the user a@b.co", schema);

    expect(result.command.seedTable).toBe("public.users");
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain(
      "plan needs a seed table and a where predicate",
    );
  });

  test("every step must be a tool call, so the model can't answer without looking", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [submit("1", plan)] });
    await generateCommand(model, "anything", schema);
    expect(model.doGenerateCalls[0]!.toolChoice).toEqual({ type: "required" });
  });

  test("a follow-up sends the earlier requests and commands, but not their lookup results", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [submit("1", { ...plan, where: "id = 2" })],
    });

    const result = await generateCommand(model, "use id 2 instead", schema, {
      history: [
        { request: "preview user 1", command: parseAiCommand({ ...plan, where: "id = 1" }) },
      ],
    });

    expect(result.command.where).toBe("id = 2");
    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(sent).toContain("preview user 1");
    expect(sent).toContain("id = 1");
    expect(sent).toContain("use id 2 instead");
    expect(sent).not.toContain("tool-result");
  });

  test("stops at the token cap instead of exploring forever", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: Array.from({ length: 10 }, (_, i) => ({
        ...toolCall(String(i), "describe_table", { table: "public.users" }),
        usage: usage(4_000),
      })),
    });

    await expect(
      generateCommand(model, "anything", schema, { maxPromptTokens: 10_000 }),
    ).rejects.toThrow(
      /stopped at the token cap \(10,000 input tokens\).*tributary config set ai\.maxPromptTokens/,
    );
    expect(model.doGenerateCalls.length).toBe(3);
  });
});
