import { test, expect } from "@playwright/test";
import path from "node:path";
import { startWorkflowServer } from "../../src/app/workflow/server";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

test("desktop uses the same headless SDK backend through a bounded IPC bridge", async () => {
  const profile = await makeProfile();
  const server = await startWorkflowServer({ root: path.join(profile, "workflows"), port: 0, sdkEnv: {} });
  let app;
  try {
    app = await launchApp(profile, true, { REELS_WORKFLOW_URL: server.url });
    const page = await app.firstWindow();
    const capability = await page.evaluate(() => window.reels!.workflow!.request("capabilities"));
    expect(capability.priority).toEqual(["codex-login"]);
    await page.getByRole("button", { name: "워크플로", exact: true }).click();
    await expect(page.getByRole("heading", { name: "제작 워크플로" })).toBeVisible();
    await expect(page.getByRole("button", { name: "새 워크플로", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { await closeApp(app); await server.close(); await cleanProfile(profile); }
});
