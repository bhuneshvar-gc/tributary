import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/program.js";
import { openUserConfig, type UserConfigStore } from "../../src/user-config.js";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A CLI with its own working directory and user config, run in-process. */
/**
 * `answers` stands in for a person at the terminal: each confirmation
 * prompt takes the next one. Without it the CLI is non-interactive.
 */
export function testCli(cwd = mkdtempSync(join(tmpdir(), "tributary-cli-")), answers?: boolean[]) {
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
