import { defineConfig, devices } from "@playwright/test";

const built = process.env.REELS_TEST_BUILT === "1";
const baseURL = `http://127.0.0.1:${built ? 4187 : 4173}`;

export default defineConfig({
  testDir: "./tests/web",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  outputDir: "test-results/web",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/web", open: "never" }],
  ],
  use: {
    headless: true,
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: built ? "vite preview --host 127.0.0.1 --port 4187 --strictPort" : "npm run dev -- --port 4173 --strictPort",
    url: baseURL,
    reuseExistingServer: !built && !process.env.CI,
    timeout: 30_000,
  },
});
