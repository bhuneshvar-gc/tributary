import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type ProjectConfig, parseProjectConfig } from "@bhuneshvar-k/tributary-core";
import { loadConfig } from "c12";

/**
 * Loads tributary.config.{ts,mts,js,mjs,json,yaml,...} from `cwd`, or the
 * explicit `path`. No file means an all-defaults config.
 */
export async function loadProjectConfig(cwd: string, path?: string): Promise<ProjectConfig> {
  if (path && !existsSync(resolve(cwd, path))) throw new Error(`config file not found: ${path}`);
  const { config } = await loadConfig({
    cwd,
    name: "tributary",
    ...(path && { configFile: resolve(cwd, path) }),
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
  });
  return parseProjectConfig(config ?? {});
}
