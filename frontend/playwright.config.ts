import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 3100;
const BACKEND_PORT = 3101;

// Chromium comes from PLAYWRIGHT_BROWSERS_PATH (pre-installed); this project never runs `playwright install`.
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    locale: "ar-AE",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node tests/e2e/support/stub-backend.mjs",
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      env: { STUB_BACKEND_PORT: String(BACKEND_PORT) },
      // Never reuse a running server: a leftover one would serve an older build.
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      // A production build, in live mode: the browser calls the real same-origin /api/* and the rewrite forwards it to the stub.
      command: `pnpm build && pnpm exec next start --hostname 127.0.0.1 --port ${APP_PORT}`,
      url: `http://127.0.0.1:${APP_PORT}/login`,
      env: {
        BACKEND_ORIGIN: `http://127.0.0.1:${BACKEND_PORT}`,
        NEXT_PUBLIC_API_MODE: "live",
        NEXT_PUBLIC_TERMS_VERSION: "2026-10-04",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
