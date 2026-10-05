import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
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

describe("update notices", () => {
  function cliWithRegistry(latest: string | undefined) {
    const installs: string[] = [];
    const cli = testCli(undefined, undefined, {
      fetchLatest: async () => latest,
      install: async (spec) => {
        installs.push(spec);
      },
    });
    return { cli, installs };
  }

  test("a newer version is announced on stderr after the command", async () => {
    const { cli } = cliWithRegistry("9.0.0");
    const result = await cli.run("config", "path");

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Update");
    expect(result.stderr).toContain(
      `Update available: ${pkg.version} → 9.0.0. Run: tributary update`,
    );
  });

  test("nothing is announced when up to date", async () => {
    const { cli } = cliWithRegistry(pkg.version);
    expect((await cli.run("config", "path")).stderr).toBe("");
  });

  test("updates.check false turns the check off", async () => {
    const { cli } = cliWithRegistry("9.0.0");
    expect((await cli.run("config", "set", "updates.check", "false")).code).toBe(0);
    expect((await cli.run("config", "path")).stderr).toBe("");
    expect(cli.userConfig.get("updates.check")).toBe(false);
  });

  test("TRIBUTARY_NO_UPDATE_CHECK=1 turns the check off", async () => {
    const { cli } = cliWithRegistry("9.0.0");
    process.env.TRIBUTARY_NO_UPDATE_CHECK = "1";
    try {
      expect((await cli.run("config", "path")).stderr).toBe("");
    } finally {
      delete process.env.TRIBUTARY_NO_UPDATE_CHECK;
    }
  });
});

describe("tributary update", () => {
  test("installs the latest version when there's a newer one", async () => {
    const installs: string[] = [];
    const cli = testCli(undefined, undefined, {
      fetchLatest: async () => "9.0.0",
      install: async (spec) => {
        installs.push(spec);
      },
    });

    const result = await cli.run("update");

    expect(result.code).toBe(0);
    expect(installs).toEqual([`${pkg.name}@9.0.0`]);
    expect(result.stdout).toContain(`updated ${pkg.name} ${pkg.version} → 9.0.0`);
    expect(result.stderr).not.toContain("Update available");
  });

  test("says so when already up to date", async () => {
    const installs: string[] = [];
    const cli = testCli(undefined, undefined, {
      fetchLatest: async () => pkg.version,
      install: async (spec) => {
        installs.push(spec);
      },
    });

    expect((await cli.run("update")).stdout).toBe(
      `${pkg.name} ${pkg.version} is the latest version\n`,
    );
    expect(installs).toEqual([]);
  });

  test("an unreachable registry is an error", async () => {
    const cli = testCli(undefined, undefined, {
      fetchLatest: async () => undefined,
      install: async () => {},
    });

    const result = await cli.run("update");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "couldn't get the latest version from the npm registry (offline, or not published yet?)",
    );
  });
});
