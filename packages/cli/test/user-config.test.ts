import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { openUserConfig, type UserConfigStore } from "../src/user-config.js";

let dir: string;
let store: UserConfigStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tributary-config-"));
  store = openUserConfig({ dir });
});

describe("user config", () => {
  test("a connection set by name can be read back", () => {
    store.set("connections.prod.url", "postgres://u:p@prod/app");
    expect(store.get("connections.prod.url")).toBe("postgres://u:p@prod/app");
    expect(store.connectionUrl("prod")).toBe("postgres://u:p@prod/app");
  });

  test("settings persist to a plaintext JSON file", () => {
    store.set("connections.local.url", "postgres://localhost/dev");
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({
      connections: { local: { url: "postgres://localhost/dev" } },
    });
    expect(openUserConfig({ dir }).connectionUrl("local")).toBe("postgres://localhost/dev");
  });

  test("the allowlist takes a comma-separated list", () => {
    expect(store.allowlist()).toEqual([]);
    store.set("allowlist", "localhost, *.staging.internal,");
    expect(store.allowlist()).toEqual(["localhost", "*.staging.internal"]);
  });

  test("unknown keys are rejected, listing the valid ones", () => {
    expect(() => store.set("conections.prod.url", "x")).toThrow(
      /unknown config key "conections\.prod\.url".*connections\.<name>\.url/,
    );
  });

  test("ai.provider must be a supported provider", () => {
    store.set("ai.provider", "anthropic");
    expect(store.get("ai.provider")).toBe("anthropic");
    expect(() => store.set("ai.provider", "skynet")).toThrow(/ai\.provider must be one of/);
  });

  test("unset removes a key", () => {
    store.set("ai.model", "x");
    store.unset("ai.model");
    expect(store.get("ai.model")).toBeUndefined();
  });

  test("an unknown connection name says how to add it", () => {
    store.set("connections.prod.url", "postgres://prod/app");
    expect(() => store.connectionUrl("staging")).toThrow(
      /no connection named "staging" \(known: prod\); add it with: tributary config set connections\.staging\.url/,
    );
  });
});

describe("where the config lives", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tributary-home-"));
  });

  test("defaults to ~/.config/tributary/config.json on macOS", () => {
    const s = openUserConfig({ home, platform: "darwin", env: {} });
    expect(s.path).toBe(join(home, ".config", "tributary", "config.json"));
  });

  test("follows XDG_CONFIG_HOME when set", () => {
    const xdg = join(home, "xdg");
    const s = openUserConfig({ home, platform: "linux", env: { XDG_CONFIG_HOME: xdg } });
    expect(s.path).toBe(join(xdg, "tributary", "config.json"));
  });

  test("TRIBUTARY_CONFIG_DIR overrides everything", () => {
    const custom = join(home, "custom");
    const s = openUserConfig({ home, platform: "darwin", env: { TRIBUTARY_CONFIG_DIR: custom } });
    expect(s.path).toBe(join(custom, "config.json"));
  });

  test("moves settings from the old macOS location", () => {
    const legacy = join(home, "Library", "Preferences", "tributary");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ allowlist: ["localhost"] }));

    const s = openUserConfig({ home, platform: "darwin", env: {} });

    expect(s.allowlist()).toEqual(["localhost"]);
    expect(existsSync(join(legacy, "config.json"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "the file is readable by its owner only, even if it was created looser",
    () => {
      const dir = join(home, ".config", "tributary");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), "{}", { mode: 0o644 });

      const s = openUserConfig({ home, platform: "darwin", env: {} });
      expect(statSync(s.path).mode & 0o777).toBe(0o600);

      s.set("connections.prod.url", "postgres://u:secret@prod/app");
      expect(statSync(s.path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );
});
