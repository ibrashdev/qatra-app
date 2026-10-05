import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/unit/setup.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    // Heavy screen suites pass alone but exceed the 5 s default when many jsdom workers run in parallel.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
