import Conf from "conf";

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "opencode",
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

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
        throw new Error(
          `ai.provider must be one of: ${AI_PROVIDERS.join(", ")}`,
        );
      }
      return s;
    },
  },
  {
    pattern: /^ai\.(model|apiKey|baseUrl)$/,
    example: "ai.model | ai.apiKey | ai.baseUrl",
    parse: (s) => s,
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

/**
 * Opens the user config. `dir` overrides the OS config directory (also
 * settable with TRIBUTARY_CONFIG_DIR, e.g. for CI).
 */
export function openUserConfig(
  options: { dir?: string } = {},
): UserConfigStore {
  const dir = options.dir ?? process.env.TRIBUTARY_CONFIG_DIR;
  const conf = new Conf<UserConfig>({
    projectName: "tributary",
    projectSuffix: "",
    ...(dir && { cwd: dir }),
  });

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
