import { defineConfig } from "@playwright/test";

const target =
  process.env.REELS_LIVE_LIBRARY_QA === "1"
    ? "live"
    : process.env.REELS_ELECTRON_EXECUTABLE
      ? "packaged"
      : "development";

export default defineConfig({
  testDir: "./tests/electron",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: `artifacts/electron-${target}/report`, open: "never" },
    ],
    ["json", { outputFile: `artifacts/electron-${target}/results.json` }],
  ],
  outputDir: `artifacts/electron-${target}/results`,
});
