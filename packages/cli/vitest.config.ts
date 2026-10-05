import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@bhuneshvar-k/source"] },
  ssr: { resolve: { conditions: ["@bhuneshvar-k/source"] } },
  test: {
    name: "cli",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
