import { readFileSync } from "node:fs";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startPostgres, type TestPostgres } from "../../core/test/support/postgres.js";
import { type Terminal, testCli } from "./support/cli.js";

const fixture = readFileSync(
  new URL("../../core/test/fixtures/source.sql", import.meta.url),
  "utf8",
);

let source: TestPostgres;
beforeAll(async () => {
  source = await startPostgres();
  await source.exec(fixture);
  await source.exec(`insert into parent_table values (1, 'first'), (2, 'second');`);
});
afterAll(() => source.close());

const usage = {
  inputTokens: { total: 500, noCache: 500, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

/** A model that, on each request, submits the next of `commands`. */
function modelSubmitting(...commands: object[]) {
  return new MockLanguageModelV4({
    doGenerate: commands.map((command, i) => ({
      content: [
        {
          type: "tool-call" as const,
          toolCallId: String(i),
          toolName: "submit_command",
          input: JSON.stringify(command),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage,
      warnings: [],
    })),
  });
}

const planOf = (where: string) => ({
  command: "plan",
  seedTable: "public.parent_table",
  where,
  traversal: null,
  fresh: null,
  explanation: `preview parent ${where}`,
  warnings: [],
});

function aiCli(model: MockLanguageModelV4, terminal?: Terminal) {
  const cli = testCli({ model, ...(terminal && { terminal }) });
  cli.userConfig.set("connections.src.url", source.url);
  return cli;
}

describe("tributary ai", () => {
  test("a follow-up revises the command, which then runs", async () => {
    const model = modelSubmitting(planOf("id = 1"), planOf("id = 2"));
    const cli = aiCli(model, { choices: ["follow-up", "run"], texts: ["use parent 2 instead"] });

    const result = await cli.run("ai", "preview parent 1", "--source", "src");

    expect(result.code).toBe(0);
    expect(cli.prompts).toEqual(["What next?", "What should change?", "What next?"]);
    expect(result.stderr).toContain("--where 'id = 1'");
    expect(result.stderr).toContain("--where 'id = 2'");
    expect(result.stdout).toContain("public.parent_table");
    const followUp = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(followUp).toContain("preview parent 1");
    expect(followUp).toContain("use parent 2 instead");
  });

  test("cancel runs nothing", async () => {
    const cli = aiCli(modelSubmitting(planOf("id = 1")), { choices: ["cancel"] });

    const result = await cli.run("ai", "preview parent 1", "--source", "src");

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("public.parent_table");
    expect(result.stderr).toContain("Not run.");
  });

  test("an empty follow-up goes back to the menu", async () => {
    const cli = aiCli(modelSubmitting(planOf("id = 1")), {
      choices: ["follow-up", "cancel"],
      texts: [""],
    });

    await cli.run("ai", "preview parent 1", "--source", "src");

    expect(cli.prompts).toEqual(["What next?", "What should change?", "What next?"]);
  });

  test("--yes runs straight away without asking", async () => {
    const cli = aiCli(modelSubmitting(planOf("id = 1")), { choices: ["cancel"] });

    const result = await cli.run("ai", "preview parent 1", "--source", "src", "--yes");

    expect(cli.prompts).toEqual([]);
    expect(result.stdout).toContain("public.parent_table");
  });

  test("with no terminal, a read-only command runs as before", async () => {
    const cli = aiCli(modelSubmitting(planOf("id = 1")));

    const result = await cli.run("ai", "preview parent 1", "--source", "src");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("public.parent_table");
  });

  test("with no terminal, a sync still needs --yes", async () => {
    const sync = { ...planOf("id = 1"), command: "sync" };
    const cli = aiCli(modelSubmitting(sync));

    const result = await cli.run("ai", "copy parent 1", "--source", "src", "--target", "src");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pass --yes to run it");
  });

  test("each round prints its token usage", async () => {
    const cli = aiCli(modelSubmitting(planOf("id = 1"), planOf("id = 2")), {
      choices: ["follow-up", "cancel"],
      texts: ["parent 2"],
    });

    const result = await cli.run("ai", "preview parent 1", "--source", "src");

    expect(result.stderr.match(/ai: 500 tokens in, 50 out, 1 step/g)).toHaveLength(2);
  });
});
