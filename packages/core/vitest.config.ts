import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    globalSetup: ["./test/support/global-postgres.ts"],
    name: "core",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
