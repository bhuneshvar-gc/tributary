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
export function testCli(cwd = mkdtempSync(join(tmpdir(), "tributary-cli-"))) {
  const userConfig: UserConfigStore = openUserConfig({
    dir: mkdtempSync(join(tmpdir(), "tributary-config-")),
  });
  return {
    cwd,
    userConfig,
    async run(...argv: string[]): Promise<CliResult> {
      let stdout = "";
      let stderr = "";
      const code = await run(argv, {
        cwd,
        userConfig,
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
