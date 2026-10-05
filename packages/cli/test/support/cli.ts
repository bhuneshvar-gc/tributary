import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
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

/** A scripted person at the terminal; each prompt takes the next answer of its kind. */
export interface Terminal {
  /** Yes/no questions. */
  confirms?: boolean[];
  /** Menu picks, by choice value; undefined cancels. */
  choices?: (string | undefined)[];
  /** Typed answers; undefined cancels. */
  texts?: (string | undefined)[];
}

export interface TestCliOptions {
  cwd?: string;
  /** Omit for a non-interactive CLI (no terminal: CI, pipes). */
  terminal?: Terminal;
  /** Stands in for the npm registry (offline by default). */
  updates?: UpdateSource;
  progress?: (message: string) => void;
  /** Stands in for the configured AI model. */
  model?: LanguageModel;
}

export function testCli(options: TestCliOptions = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "tributary-cli-"));
  const { terminal, progress, model } = options;
  const updates = options.updates ?? offline;
  const prompts: string[] = [];
  const userConfig: UserConfigStore = openUserConfig({
    dir: mkdtempSync(join(tmpdir(), "tributary-config-")),
  });
  return {
    cwd,
    userConfig,
    /** Every question asked so far, of any kind. */
    prompts,
    async run(...argv: string[]): Promise<CliResult> {
      let stdout = "";
      let stderr = "";
      const code = await run(argv, {
        cwd,
        userConfig,
        updates,
        ...(progress && { progress }),
        ...(model && { model: () => model }),
        ...(terminal && {
          confirm: async (message: string) => {
            prompts.push(message);
            return terminal.confirms?.shift() ?? false;
          },
          choose: async (message: string) => {
            prompts.push(message);
            return terminal.choices?.shift();
          },
          ask: async (message: string) => {
            prompts.push(message);
            return terminal.texts?.shift();
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
