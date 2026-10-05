import { describe, expect, test } from "vitest";
import { checkTargetAllowed, TargetNotAllowedError } from "../src/index.js";

describe("checkTargetAllowed", () => {
  test("an empty allowlist denies every target", () => {
    expect(() => checkTargetAllowed("postgres://u:p@localhost/db", [])).toThrow(
      TargetNotAllowedError,
    );
  });

  test("an exact host is allowed, case-insensitively", () => {
    expect(() =>
      checkTargetAllowed("postgres://u@LocalHost:5433/db", ["localhost"]),
    ).not.toThrow();
  });

  test("a wildcard matches any subdomain depth", () => {
    expect(() =>
      checkTargetAllowed("postgres://db.eu.staging.internal/x", [
        "*.staging.internal",
      ]),
    ).not.toThrow();
  });

  test("a host outside the allowlist is denied, naming the host", () => {
    expect(() =>
      checkTargetAllowed("postgres://u:secret@prod-db.example.com/app", [
        "localhost",
        "*.staging",
      ]),
    ).toThrow(/"prod-db\.example\.com" is not in the target allowlist/);
  });

  test("the error never echoes the password", () => {
    try {
      checkTargetAllowed("postgres://u:hunter2@prod/app", ["localhost"]);
    } catch (e) {
      expect(String(e)).not.toContain("hunter2");
    }
  });

  test("a wildcard doesn't match a suffix without the dot", () => {
    expect(() =>
      checkTargetAllowed("postgres://evilstaging/x", ["*.staging"]),
    ).toThrow(TargetNotAllowedError);
  });

  test("a unix socket directory matches by path", () => {
    expect(() =>
      checkTargetAllowed("postgres:///app?host=/var/run/postgresql", [
        "/var/run/postgresql",
      ]),
    ).not.toThrow();
  });
});
