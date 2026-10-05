import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import Conf from "conf";

import { AI_PROVIDERS, type AiProvider } from "./providers.js";

export type { AiProvider };

/**
 * Machine-local settings, kept out of the project: named connections,
 * the target allowlist and AI credentials. Stored as plaintext JSON.
 */
export interface UserConfig {
  connections?: Record<string, { url: string }>;
  allowlist?: string[];
  ai?: {
    provider?: AiProvider;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** Update notices; on unless `check` is false. */
  updates?: { check?: boolean };
}

/** A settable key, its description, and how its CLI string is parsed. */
interface KeySpec {
  pattern: RegExp;
  example: string;
  parse(raw: string): unknown;
}

const KEYS: KeySpec[] = [
  {
    pattern: /^connections\.[\w-]+\.url$/,
    example: "connections.<name>.url",
    parse: (s) => s,
  },
  {
    pattern: /^allowlist$/,
    example: "allowlist",
    parse: (s) =>
      s
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
  },
  {
    pattern: /^ai\.provider$/,
    example: "ai.provider",
    parse: (s) => {
      if (!(AI_PROVIDERS as readonly string[]).includes(s)) {
        throw new Error(`ai.provider must be one of: ${AI_PROVIDERS.join(", ")}`);
      }
      return s;
    },
  },
  {
    pattern: /^ai\.(model|apiKey|baseUrl)$/,
    example: "ai.model | ai.apiKey | ai.baseUrl",
    parse: (s) => s,
  },
  {
    pattern: /^updates\.check$/,
    example: "updates.check",
    parse: (s) => {
      if (s !== "true" && s !== "false") throw new Error("updates.check must be true or false");
      return s === "true";
    },
  },
];

function spec(key: string): KeySpec {
  const found = KEYS.find((k) => k.pattern.test(key));
  if (!found) {
    throw new Error(
      `unknown config key "${key}"; valid keys: ${KEYS.map((k) => k.example).join(", ")}`,
    );
  }
  return found;
}

export interface UserConfigStore {
  /** The JSON file the settings live in. */
  readonly path: string;
  get(key: string): unknown;
  /** Sets a key from its CLI string form (allowlist takes a comma-separated list). */
  set(key: string, raw: string): void;
  unset(key: string): void;
  all(): UserConfig;
  connectionUrl(name: string): string;
  allowlist(): string[];
}

export interface OpenUserConfigOptions {
  /** Use this directory instead of the default (see configDir). */
  dir?: string;
  /** For tests: the environment, home directory and platform to resolve against. */
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Where the config lives: TRIBUTARY_CONFIG_DIR if set, else
 * $XDG_CONFIG_HOME/tributary or ~/.config/tributary on macOS and Linux
 * alike, and %APPDATA%\tributary on Windows.
 */
export function configDir(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  if (env.TRIBUTARY_CONFIG_DIR) return env.TRIBUTARY_CONFIG_DIR;
  if (platform === "win32")
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "tributary");
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "tributary");
}

/** Before 0.1.0, macOS settings lived in ~/Library/Preferences; move them once. */
function migrateLegacyMacConfig(home: string, dir: string): void {
  const legacyDir = join(home, "Library", "Preferences", "tributary");
  const legacy = join(legacyDir, "config.json");
  const current = join(dir, "config.json");
  if (!existsSync(legacy) || existsSync(current)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(legacy, current);
  rmSync(legacyDir, { recursive: true, force: true });
}

/**
 * Opens the user config. The file holds connection passwords and API
 * keys in plaintext, so it's kept owner-only: the directory 0700, the
 * file 0600 (tightened if an older file was created looser).
 */
export function openUserConfig(options: OpenUserConfigOptions = {}): UserConfigStore {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const dir = options.dir ?? configDir(env, home, platform);
  if (!options.dir && platform === "darwin" && !env.TRIBUTARY_CONFIG_DIR)
    migrateLegacyMacConfig(home, dir);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const conf = new Conf<UserConfig>({
    projectName: "tributary",
    cwd: dir,
    configFileMode: 0o600,
  });
  if (platform !== "win32") {
    chmodSync(dir, 0o700);
    if (existsSync(conf.path)) chmodSync(conf.path, 0o600);
  }

  return {
    path: conf.path,
    get: (key) => conf.get(key as keyof UserConfig),
    set(key, raw) {
      conf.set(key, spec(key).parse(raw));
    },
    unset(key) {
      spec(key);
      conf.delete(key as keyof UserConfig);
    },
    all: () => conf.store,
    connectionUrl(name) {
      const url = conf.store.connections?.[name]?.url;
      if (!url) {
        const known = Object.keys(conf.store.connections ?? {});
        throw new Error(
          `no connection named "${name}"${known.length ? ` (known: ${known.join(", ")})` : ""}; add it with: tributary config set connections.${name}.url <postgres-url>`,
        );
      }
      return url;
    },
    allowlist: () => conf.store.allowlist ?? [],
  };
}
