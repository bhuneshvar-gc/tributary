import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import semver from "semver";

/**
 * How long a registry answer is reused. 0 checks on every run; raise it
 * (e.g. to a day) to check less often. Answers are cached either way.
 */
export const CHECK_INTERVAL_MS = 0;

/** How long the registry gets before the check gives up silently. */
const TIMEOUT_MS = 1_500;

export interface AvailableUpdate {
  current: string;
  latest: string;
}

/** Where updates come from and how they're installed (injectable for tests). */
export interface UpdateSource {
  /** The latest published version, or undefined if the registry can't be reached. */
  fetchLatest(): Promise<string | undefined>;
  /** Installs `spec` ("name@version") globally. */
  install(spec: string): Promise<void>;
}

interface Cache {
  checkedAt: number;
  latest: string;
}

function readCache(path: string): Cache | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<Cache>;
    return typeof data.checkedAt === "number" && typeof data.latest === "string"
      ? { checkedAt: data.checkedAt, latest: data.latest }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a newer version than `current` is published. Never throws: an
 * unreachable registry, a bad answer or an unwritable cache all just mean
 * no notice. A cached answer younger than `intervalMs` is reused.
 */
export async function checkForUpdate(options: {
  current: string;
  cachePath: string;
  intervalMs: number;
  now?: () => number;
  fetchLatest: UpdateSource["fetchLatest"];
}): Promise<AvailableUpdate | undefined> {
  const now = (options.now ?? Date.now)();
  const cached = readCache(options.cachePath);
  let latest = cached && now - cached.checkedAt < options.intervalMs ? cached.latest : undefined;
  if (latest === undefined) {
    latest = await options.fetchLatest().catch(() => undefined);
    if (latest === undefined) return undefined;
    try {
      mkdirSync(dirname(options.cachePath), { recursive: true, mode: 0o700 });
      writeFileSync(options.cachePath, JSON.stringify({ checkedAt: now, latest } satisfies Cache));
    } catch {
      // A cache we can't write only costs a fresh check next time.
    }
  }
  if (!semver.valid(latest) || !semver.valid(options.current)) return undefined;
  return semver.gt(latest, options.current) ? { current: options.current, latest } : undefined;
}

/** The real thing: the public npm registry, and `npm install -g`. */
export function npmUpdateSource(packageName: string): UpdateSource {
  return {
    async fetchLatest() {
      try {
        const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        const { version } = (await response.json()) as { version?: unknown };
        return typeof version === "string" ? version : undefined;
      } catch {
        return undefined;
      }
    },
    install(spec) {
      return new Promise((resolve, reject) => {
        const npm = process.platform === "win32" ? "npm.cmd" : "npm";
        const child = spawn(npm, ["install", "-g", spec], { stdio: "inherit" });
        child.on("error", (e) => reject(new Error(`couldn't run npm: ${e.message}`)));
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`npm install -g ${spec} failed (exit code ${code})`)),
        );
      });
    },
  };
}
