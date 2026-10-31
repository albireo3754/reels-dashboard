import { expect, test, type ElectronApplication } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

let app: ElectronApplication | undefined;
let profile: string;

test.beforeEach(async () => {
  profile = await makeProfile();
  app = await launchApp(profile);
});

test.afterEach(async () => {
  await closeApp(app);
  app = undefined;
  await cleanProfile(profile);
});

test("loads built React UI with an isolated, typed preload bridge", async ({}, testInfo) => {
  const page = await app!.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("body")).toContainText("Reels");
  await expect.poll(() => page.evaluate(() => window.reels?.mode)).toBe("demo");
  const runtime = await app!.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const preferences = (
      window.webContents as unknown as {
        getLastWebPreferences(): {
          nodeIntegration: boolean;
          contextIsolation: boolean;
          sandbox: boolean;
        };
      }
    ).getLastWebPreferences();
    return {
      nodeIntegration: preferences.nodeIntegration,
      contextIsolation: preferences.contextIsolation,
      sandbox: preferences.sandbox,
      url: window.webContents.getURL(),
      packaged: app.isPackaged,
    };
  });
  expect(runtime.nodeIntegration).toBe(false);
  expect(runtime.contextIsolation).toBe(true);
  expect(runtime.sandbox).toBe(true);
  expect(runtime.url).not.toMatch(/^https?:/);
  expect(runtime.url).toContain("dist");
  expect(
    await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).require,
    ),
  ).toBe("undefined");
  expect(await page.evaluate(() => Object.keys(window.reels!).sort())).toEqual(
    [
      "chooseDestination",
      "agent",
      "editor",
      "exportSnapshot",
      "imageURL",
      "loadDashboard",
      "mobileBriefing",
      "mode",
      "openDocument",
      "request",
      "saveDashboard",
      "saveDocument",
      "syncSnapshot",
    ].sort(),
  );
  expect(await page.evaluate(() => Object.keys(window.reels!.editor).sort())).toEqual(
    ["runtime", "chooseVideo", "fromPhotos", "list", "load", "save", "preview", "export", "job", "cancel", "reveal"].sort(),
  );
  expect(errors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-fixture.png"),
    fullPage: true,
  });
});

test("rejects unsupported commands and untrusted local paths across the real IPC bridge", async () => {
  const page = await app!.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.reels)))
    .toBe(true);
  const outcomes = await page.evaluate(async () => {
    const bridge = window.reels!;
    const attempt = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return { rejected: false, message: "" };
      } catch (error) {
        return { rejected: true, message: String(error) };
      }
    };
    return {
      command: await attempt(() =>
        bridge.request("arbitrary.shell" as never, { command: "echo unsafe" }),
      ),
      traversal: await attempt(() =>
        bridge.saveDocument("../escape.json", { value: "unsafe" }),
      ),
      absolute: await attempt(() =>
        bridge.saveDocument("/tmp/reels-escape.json", { value: "unsafe" }),
      ),
      arbitraryImage: await attempt(() => bridge.imageURL("/etc/passwd")),
    };
  });
  for (const outcome of Object.values(outcomes)) {
    expect(outcome.rejected).toBe(true);
    expect(outcome.message.length).toBeGreaterThan(0);
  }
});

test("persists dashboard through app restart using the same isolated user data directory", async () => {
  let page = await app!.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.reels)))
    .toBe(true);
  const dashboard = {
    schemaVersion: 1 as const,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [
      {
        id: "qa-project",
        title: "QA 촬영 계획",
        date: "2026-01-01",
        stage: "editing" as const,
        nextAction: "표지 검토",
        publicURL: "",
        shared: false,
      },
    ],
  };
  await page.evaluate((value) => window.reels!.saveDashboard(value), dashboard);
  expect(
    (await page.evaluate(() => window.reels!.loadDashboard())).projects,
  ).toEqual(dashboard.projects);
  await closeApp(app);
  app = undefined;
  app = await launchApp(profile);
  page = await app.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.reels)))
    .toBe(true);
  expect(
    (await page.evaluate(() => window.reels!.loadDashboard())).projects,
  ).toEqual(dashboard.projects);
});

test("fixture mode exercises status, sync, group and inspection through desktop IPC", async () => {
  const page = await app!.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.reels)))
    .toBe(true);
  const result = await page.evaluate(async () => {
    const bridge = window.reels!;
    const status = await bridge.request<{ permission: string }>("status");
    const sync = await bridge.request<{ indexRunID: string }>("sync", {
      date: "2026-01-01",
    });
    const groups = await bridge.request<{
      indexRunID: string;
      groups: { id: string; assetIDs: string[] }[];
    }>("groups.list", { date: "2026-01-01", level: "fine" });
    const group = groups.groups[0];
    if (!group)
      throw new Error("The desktop fixture must include a capture group");
    const detail = await bridge.request<{
      group: { id: string };
      assets: unknown[];
    }>("groups.show", { id: group.id, "index-run": groups.indexRunID });
    const inspection = await bridge.request<{
      page: { pageNumber: number };
      sampleFiles: string[];
    }>("groups.inspect", {
      id: group.id,
      "index-run": groups.indexRunID,
      samples: "12",
      page: "1",
      "page-size": "12",
    });
    return {
      status,
      sync,
      groupCount: groups.groups.length,
      detail,
      inspection,
    };
  });
  expect(result.status.permission).toBe("authorized");
  expect(result.sync.indexRunID).toBeTruthy();
  expect(result.groupCount).toBeGreaterThan(0);
  expect(result.detail.assets.length).toBeGreaterThan(0);
  expect(result.inspection.page.pageNumber).toBe(1);
  expect(result.inspection.sampleFiles.length).toBeGreaterThan(0);
});

test("fixture copy and move workflows preserve validation, digest and explicit move confirmation", async () => {
  const page = await app!.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.reels)))
    .toBe(true);
  const prepared = await page.evaluate(async () => {
    const bridge = window.reels!;
    await bridge.request("authorize");
    await bridge.request("sync", { date: "2026-01-01" });
    const groups = await bridge.request<{
      indexRunID: string;
      groups: { id: string; assetIDs: string[] }[];
    }>("groups.list", { level: "fine" });
    const group = groups.groups[0]!;
    const decision = {
      schemaVersion: 1,
      indexRunID: groups.indexRunID,
      groupID: group.id,
      label: "QA-fixture",
      confidence: 1,
      includedAssetIDs: group.assetIDs,
      excludedAssetIDs: [],
      evidenceReferences: [],
      unknowns: [],
    };
    const decisionPath = await bridge.saveDocument("qa-decision", decision);
    const validation = await bridge.request<{ valid: boolean }>(
      "decisions.validate",
      { file: decisionPath },
    );
    const destination = await bridge.chooseDestination();
    if (!destination) throw new Error("Fixture destination unavailable");
    const exportPlan = await bridge.request<{
      plan: Record<string, unknown>;
      digest: string;
    }>("export.plan", {
      decision: decisionPath,
      to: destination,
      layout: "dated-group",
    });
    const exportPath = await bridge.saveDocument(
      "qa-export-plan",
      exportPlan.plan,
    );
    let badDigestRejected = false;
    try {
      await bridge.request("export.apply", {
        plan: exportPath,
        digest: "0".repeat(64),
      });
    } catch {
      badDigestRejected = true;
    }
    const receipt = await bridge.request<{ entries: unknown[] }>(
      "export.apply",
      { plan: exportPath, digest: exportPlan.digest },
    );
    const movePlan = await bridge.request<{
      plan: Record<string, unknown>;
      digest: string;
    }>("move.plan", {
      decision: decisionPath,
      to: destination,
      layout: "dated-group",
    });
    const movePath = await bridge.saveDocument("qa-move-plan", movePlan.plan);
    return {
      validation,
      badDigestRejected,
      copied: receipt.entries.length,
      selected: group.assetIDs.length,
      movePath,
      moveDigest: movePlan.digest,
    };
  });
  expect(prepared.validation.valid).toBe(true);
  expect(prepared.badDigestRejected).toBe(true);
  expect(prepared.copied).toBe(prepared.selected);

  // Only the explicit fixture mode is running: these dialog responses cannot delete Photos assets.
  await app!.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  const cancelled = await page.evaluate(async ({ movePath, moveDigest }) => {
    try {
      await window.reels!.request("move.apply", {
        plan: movePath,
        digest: moveDigest,
      });
      return false;
    } catch {
      return true;
    }
  }, prepared);
  expect(cancelled).toBe(true);
  await app!.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  const moved = await page.evaluate(
    ({ movePath, moveDigest }) =>
      window.reels!.request<{ deletedAssetIDs: string[] }>("move.apply", {
        plan: movePath,
        digest: moveDigest,
      }),
    prepared,
  );
  expect(moved.deletedAssetIDs).toHaveLength(prepared.selected);
});

test("desktop file dialogs round-trip documents and export only shared dashboard entries", async () => {
  const page = await app!.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.reels)))
    .toBe(true);
  const documentPath = await page.evaluate(() =>
    window.reels!.saveDocument("한글_문서", {
      kind: "fixture",
      title: "촬영 계획",
    }),
  );
  await app!.evaluate(({ dialog }, documentPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [documentPath],
    });
  }, documentPath);
  const document = await page.evaluate(() => window.reels!.openDocument());
  expect(document?.data).toEqual({ kind: "fixture", title: "촬영 계획" });
  expect(document?.path).toBe(documentPath);

  await page.evaluate(() =>
    window.reels!.saveDashboard({
      schemaVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      projects: [
        {
          id: "visible",
          title: "공유 항목",
          date: "2026-01-01",
          stage: "review",
          nextAction: "확인",
          publicURL: "",
          shared: true,
        },
        {
          id: "private",
          title: "비공유 항목",
          date: "2026-01-01",
          stage: "idea",
          nextAction: "",
          publicURL: "",
          shared: false,
        },
      ],
    }),
  );
  const snapshotPath = join(profile, "dashboard snapshot.json");
  await app!.evaluate(({ dialog }, snapshotPath) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: snapshotPath,
    });
  }, snapshotPath);
  expect(await page.evaluate(() => window.reels!.exportSnapshot())).toBe(
    snapshotPath,
  );
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.projects).toHaveLength(1);
  expect(snapshot.projects[0].id).toBe("visible");
  expect(snapshot.projects[0]).not.toHaveProperty("shared");
  expect(JSON.stringify(snapshot)).not.toContain(profile);
});
