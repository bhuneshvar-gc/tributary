import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkForUpdate } from "../src/update-check.js";

function setup(
  latest: string | Error | undefined,
  options: { intervalMs?: number; now?: number } = {},
) {
  const cachePath = join(mkdtempSync(join(tmpdir(), "tributary-update-")), "update-check.json");
  let fetches = 0;
  return {
    cachePath,
    fetches: () => fetches,
    check: (current: string, now = options.now ?? 1_000_000) =>
      checkForUpdate({
        current,
        cachePath,
        intervalMs: options.intervalMs ?? 0,
        now: () => now,
        fetchLatest: async () => {
          fetches++;
          if (latest instanceof Error) throw latest;
          return latest;
        },
      }),
  };
}

describe("checkForUpdate", () => {
  test("reports a newer published version", async () => {
    expect(await setup("0.2.0").check("0.1.0")).toEqual({ current: "0.1.0", latest: "0.2.0" });
  });

  test("says nothing when current is the latest or newer", async () => {
    expect(await setup("0.1.0").check("0.1.0")).toBeUndefined();
    expect(await setup("0.1.0").check("0.2.0-rc.1")).toBeUndefined();
  });

  test("a registry failure is silent", async () => {
    expect(await setup(new Error("ENOTFOUND registry.npmjs.org")).check("0.1.0")).toBeUndefined();
  });

  test("an unparseable version from the registry is ignored", async () => {
    expect(await setup("not-a-version").check("0.1.0")).toBeUndefined();
  });

  test("with no interval it asks the registry on every run, caching the answer", async () => {
    const s = setup("0.2.0");
    await s.check("0.1.0");
    await s.check("0.1.0");
    expect(s.fetches()).toBe(2);
    expect(JSON.parse(readFileSync(s.cachePath, "utf8"))).toEqual({
      checkedAt: 1_000_000,
      latest: "0.2.0",
    });
  });

  test("with an interval, a fresh cached answer is used without asking again", async () => {
    const day = 24 * 60 * 60 * 1000;
    const s = setup("0.2.0", { intervalMs: day });
    await s.check("0.1.0", 1_000_000);
    expect(await s.check("0.1.0", 1_000_000 + day - 1)).toEqual({
      current: "0.1.0",
      latest: "0.2.0",
    });
    expect(s.fetches()).toBe(1);
    await s.check("0.1.0", 1_000_000 + day);
    expect(s.fetches()).toBe(2);
  });
});
