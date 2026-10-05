import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/program.js";
import type { UpdateSource } from "../../src/update-check.js";
import { openUserConfig, type UserConfigStore } from "../../src/user-config.js";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A CLI with its own working directory and user config, run in-process. */
/** No network: the registry is never reachable, and nothing installs. */
const offline: UpdateSource = {
  fetchLatest: async () => undefined,
  install: async () => {
    throw new Error("tests don't install");
  },
};

/**
 * `answers` stands in for a person at the terminal: each confirmation
 * prompt takes the next one. Without it the CLI is non-interactive.
 * `updates` stands in for the npm registry (offline by default).
 */
export function testCli(
  cwd = mkdtempSync(join(tmpdir(), "tributary-cli-")),
  answers?: boolean[],
  updates: UpdateSource = offline,
) {
  const prompts: string[] = [];
  const userConfig: UserConfigStore = openUserConfig({
    dir: mkdtempSync(join(tmpdir(), "tributary-config-")),
  });
  return {
    cwd,
    userConfig,
    /** Every confirmation question asked so far. */
    prompts,
    async run(...argv: string[]): Promise<CliResult> {
      let stdout = "";
      let stderr = "";
      const code = await run(argv, {
        cwd,
        userConfig,
        updates,
        ...(answers && {
          confirm: async (message: string) => {
            prompts.push(message);
            return answers.shift() ?? false;
          },
        }),
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      });
      return { code, stdout, stderr };
    },
  };
}
