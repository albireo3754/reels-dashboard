import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/workflow",
  workers: 1,
  timeout: 45000,
  outputDir: "test-results/workflow",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    screenshot: "only-on-failure",
  },
});
