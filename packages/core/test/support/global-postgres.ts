import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

import "./postgres.js"; // declares the provided pgBaseUrl

/** Postgres server binaries: PG_BIN, else pg_config's bindir, else the newest Debian/Ubuntu install. */
function binDir(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try {
    return execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  } catch {
    const root = "/usr/lib/postgresql";
    const newest = existsSync(root)
      ? readdirSync(root).sort((a, b) => Number(b) - Number(a))[0]
      : undefined;
    if (newest) return join(root, newest, "bin");
    throw new Error(
      "no Postgres server binaries found: install Postgres or set PG_BIN to its bin directory",
    );
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts one throwaway Postgres cluster for the test run: TCP only,
 * durability off (it's thrown away), torn down afterwards. Tests create
 * their own databases on it (see startPostgres).
 */
export default async function setup(project: TestProject) {
  const bin = binDir();
  const dir = mkdtempSync(join(tmpdir(), "tributary-pg-"));
  const data = join(dir, "data");
  execFileSync(join(bin, "initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync"], {
    stdio: "ignore",
  });
  const port = await freePort();
  const options = `-p ${port} -k '' -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200`;
  execFileSync(
    join(bin, "pg_ctl"),
    ["-D", data, "-o", options, "-l", join(dir, "log"), "-w", "start"],
    { stdio: "ignore" },
  );
  project.provide("pgBaseUrl", `postgres://postgres@127.0.0.1:${port}`);
  return () => {
    spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  };
}
