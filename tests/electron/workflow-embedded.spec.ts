import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { startWorkflowServer } from "../../src/app/workflow/server";
import { STALE_WORKFLOW_SERVER_MESSAGE, WORKFLOW_PROTOCOL_VERSION } from "../../src/shared/workflow";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

// Without REELS_WORKFLOW_URL the helpers give the app port 0 and a per-profile data
// dir, so the embedded server never binds 4318 or opens the user's real workflow data.
test("desktop embeds the workflow server and releases it on quit", async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true);
    const page = await app.firstWindow();
    const status = await page.evaluate(() => window.reels!.workflow!.hostStatus!());
    expect(status.state).toBe("embedded");
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(status.url).not.toBe("http://127.0.0.1:4318");
    const capability = await page.evaluate(() => window.reels!.workflow!.request("capabilities"));
    const mainPid = await app.evaluate(() => process.pid);
    expect(capability.server).toMatchObject({
      embedded: true,
      pid: mainPid,
      protocol: WORKFLOW_PROTOCOL_VERSION,
      root: await realpath(path.join(profile, "workflow-data")),
    });
    expect(capability.server.actions).toContain("suggest-inline");
    expect((await page.evaluate(() => window.reels!.workflow!.request("list"))).runs).toEqual([]);
    await page.getByRole("button", { name: "워크플로", exact: true }).click();
    await expect(page.getByRole("button", { name: "새 워크플로", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    await closeApp(app);
    app = undefined;
    // Port closed and the data-dir owner lock released: a new server can open the same data.
    await expect(fetch(status.url + "/api/workflows")).rejects.toThrow();
    const reopened = await startWorkflowServer({
      root: path.join(profile, "workflow-data"),
      port: 0,
      sdkEnv: {},
    });
    await reopened.close();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("an outdated server on the workflow port is reported, not reused or replaced", async () => {
  const profile = await makeProfile();
  // Old-style server: capabilities without `server.actions`, unknown newer routes.
  const old = createServer((req, res) => {
    res.writeHead(req.url === "/api/workflows/capabilities" || req.url === "/api/workflows" ? 200 : 404, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/api/workflows/capabilities"
          ? { sdk: true, apiKeyConfigured: false, priority: ["codex-login"], automaticAdvance: false }
          : req.url === "/api/workflows"
            ? { runs: [] }
            : { error: "Unknown workflow action" },
      ),
    );
  });
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  const port = (old.address() as { port: number }).port;
  let app;
  try {
    app = await launchApp(profile, true, { REELS_WORKFLOW_PORT: String(port) });
    const page = await app.firstWindow();
    const status = await page.evaluate(() => window.reels!.workflow!.hostStatus!());
    expect(status).toEqual({
      state: "stale",
      url: `http://127.0.0.1:${port}`,
      message: STALE_WORKFLOW_SERVER_MESSAGE,
    });
    await page.getByRole("button", { name: "워크플로", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: STALE_WORKFLOW_SERVER_MESSAGE })).toBeVisible();
    // Requests for actions the old server lacks surface the same guidance.
    await expect(
      page.evaluate(() => window.reels!.workflow!.request("forms-list", {})),
    ).rejects.toThrow(STALE_WORKFLOW_SERVER_MESSAGE);
  } finally {
    await closeApp(app);
    await new Promise<void>((resolve) => old.close(() => resolve()));
    await cleanProfile(profile);
  }
});
