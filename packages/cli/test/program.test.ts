import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { testCli } from "./support/cli.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const cli = (...argv: string[]) => testCli().run(...argv);

test("--version prints the package version", async () => {
  expect(await cli("--version")).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: "" });
});

test("a subcommand usage error returns an exit code instead of exiting the process", async () => {
  const exit = process.exit;
  let exited = false;
  process.exit = (() => {
    exited = true;
  }) as typeof process.exit;
  try {
    const result = await cli("plan", "--source", "x", "--no-such-flag");
    expect(exited).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown option '--no-such-flag'");
  } finally {
    process.exit = exit;
  }
});

test("an unknown connection name is reported with the exit code", async () => {
  const result = await cli("plan", "--source", "x");
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/no connection named "x"/);
});
