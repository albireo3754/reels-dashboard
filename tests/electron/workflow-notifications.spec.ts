import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

test("background QA has no notification polling or badge and an open event selects its workflow", async () => {
  const profile = await makeProfile();
  const runs = ["first", "target"].map((name) => ({
    runId: name,
    title: `Synthetic ${name}`,
    workspace: "/synthetic",
    instructions: "Synthetic workflow",
    trackedFiles: [],
    maxRevisions: 2,
    revisions: 0,
    sequence: 0,
    stage: "prepare",
    status: "waiting",
    history: [],
    textApproval: {},
    layoutFiles: [],
  }));
  let reads = 0;
  const server = createServer((_req, res) => {
    reads++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runs }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let electron;
  try {
    const { port } = server.address() as AddressInfo;
    electron = await launchApp(profile, true, {
      REELS_WORKFLOW_URL: `http://127.0.0.1:${port}`,
    });
    const page = await electron.firstWindow();
    await expect(
      page.getByRole("button", { name: "워크플로", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(3200);
    expect(reads).toBe(0);
    expect(await electron.evaluate(({ app }) => app.getBadgeCount())).toBe(0);
    expect(
      await page.evaluate(() => typeof window.reels?.workflow?.onOpen),
    ).toBe("function");

    // Supply a synthetic native-notification click at the existing IPC boundary.
    // The production callback and queue semantics are covered by the unit host tests.
    await electron.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler("reels:workflow:pendingOpen");
      ipcMain.handle("reels:workflow:pendingOpen", () => ({
        runId: "target",
        sequence: 1,
      }));
      BrowserWindow.getAllWindows()[0].webContents.send("workflow:open", null);
    });
    await expect(
      page.getByRole("heading", { name: "Synthetic target", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Synthetic target/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /Synthetic first/ }).click();
    await expect(
      page.getByRole("heading", { name: "Synthetic first", exact: true }),
    ).toBeVisible();
    await electron.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler("reels:workflow:pendingOpen");
      ipcMain.handle("reels:workflow:pendingOpen", () => ({
        runId: "target",
        sequence: 2,
      }));
      BrowserWindow.getAllWindows()[0].webContents.send("workflow:open", null);
    });
    await expect(
      page.getByRole("heading", { name: "Synthetic target", exact: true }),
    ).toBeVisible();
    expect(
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFocused(),
      ),
    ).toBe(false);
  } finally {
    await closeApp(electron);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await cleanProfile(profile);
  }
});
