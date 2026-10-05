import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { run } from "../src/program.js";
import { openUserConfig } from "../src/user-config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    cwd: mkdtempSync(join(tmpdir(), "tributary-cli-")),
    userConfig: openUserConfig({ dir: mkdtempSync(join(tmpdir(), "tributary-config-")) }),
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

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
    const result = await cli("plan", "--no-such-flag");
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
