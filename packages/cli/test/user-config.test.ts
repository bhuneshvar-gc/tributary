import { mkdtempSync, readFileSync } from "node:fs";
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
    expect(openUserConfig({ dir }).connectionUrl("local")).toBe(
      "postgres://localhost/dev",
    );
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
    expect(() => store.set("ai.provider", "skynet")).toThrow(
      /ai\.provider must be one of/,
    );
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
