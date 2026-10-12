import { defineConfig } from "@playwright/test";

// The UI smoke tests reuse the docker-compose stack from the API e2e tests,
// but on a fixed port so that `baseURL` can be static in this config.
// Set E2E_TEST_NO_BUILD=1 to skip rebuilding the docker image.
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  // Tests share a single seeded user and run against one app instance,
  // so they must run sequentially.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "test-results/ui",
  globalSetup: "./setup/uiGlobalSetup",
  use: {
    baseURL: process.env.UI_E2E_BASE_URL ?? "http://localhost:3210",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "smoke",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        storageState: "tests/ui/.auth/user.json",
      },
    },
  ],
});
