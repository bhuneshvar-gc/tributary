import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ProjectConfig,
  parseProjectConfig,
} from "@bhuneshvar-k/tributary-core";
import { loadConfig } from "c12";

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** The file it came from; undefined when there is none (defaults apply). */
  file: string | undefined;
}

/**
 * Loads tributary.config.{ts,mts,js,mjs,json,yaml,...} from `cwd`, or the
 * explicit `path`. No file means an all-defaults config.
 */
export async function loadProjectConfig(
  cwd: string,
  path?: string,
): Promise<LoadedProjectConfig> {
  if (path && !existsSync(resolve(cwd, path)))
    throw new Error(`config file not found: ${path}`);
  const { config, configFile } = await loadConfig({
    cwd,
    name: "tributary",
    ...(path && { configFile: resolve(cwd, path) }),
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
  });
  const file = configFile && existsSync(configFile) ? configFile : undefined;
  return { config: parseProjectConfig(config ?? {}), file };
}
