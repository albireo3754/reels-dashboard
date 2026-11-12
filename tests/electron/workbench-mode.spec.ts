import { test, expect } from "@playwright/test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

for (const flag of [undefined, "0", "true"]) {
  test(`workbench is unavailable when REELS_DEV_MODE=${flag ?? "unset"}`, async () => {
    const profile = await makeProfile();
    let app;
    try {
      // Corrupt saved settings must not affect normal mode or cause it to expose
      // workbench recovery UI. Neither a demo nor an ambient Vite flag enables it.
      await writeFile(join(profile, "workbench.json"), "invalid json");
      app = await launchApp(profile, true, {
        REELS_DEV_MODE: flag,
        VITE_REELS_DEV_MODE: "1",
      });
      const page = await app.firstWindow();
      await expect(
        page.getByRole("button", { name: "대시보드", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "터미널", exact: true }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(() => window.reels!.workbench),
      ).toBeUndefined();

      // A test-only renderer sends real IPC requests, independent of the hidden
      // preload API. Disabled mode must have no terminal handlers at all.
      const errors = await app.evaluate(async ({ BrowserWindow }) => {
        const probe = new BrowserWindow({
          show: false,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
          },
        });
        try {
          await probe.loadURL("about:blank");
          return (await probe.webContents.executeJavaScript(`
            Promise.all(${JSON.stringify(["state", "start", "write", "chooseWorkspace", "openPreview", "close", "hideWindow"])}.map(async method => {
              try { await require('electron').ipcRenderer.invoke('reels:workbench:' + method); return 'accepted'; }
              catch (error) { return String(error); }
            }))
          `)) as string[];
        } finally {
          probe.destroy();
        }
      });
      expect(errors).toHaveLength(7);
      for (const error of errors)
        expect(error).toContain("No handler registered");
      expect(await readFile(join(profile, "workbench.json"), "utf8")).toBe(
        "invalid json",
      );
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });
}

test("opt-in offers Codex (default) and Claude Code and rejects a forged unknown tool request", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "터미널", exact: true })
      .click();
    await page.getByTestId("dev-settings-toggle").click();
    const provider = page.getByRole("combobox", { name: "코딩 도구" });
    await expect(provider).toHaveValue("codex");
    await expect(provider.locator("option")).toHaveText([
      "Codex",
      "Claude Code",
    ]);
    const listed = await page.evaluate(async () => {
      const state = await window.reels!.workbench!.state();
      return { providers: state.providers, defaultProvider: state.defaultProvider };
    });
    expect(listed.providers.map((option) => option.id)).toEqual([
      "codex",
      "claude",
    ]);
    expect(listed.defaultProvider).toBe("codex");
    const result = await page.evaluate(async () => {
      try {
        await window.reels!.workbench!.start({ kind: "gemini" as never });
        return { error: "accepted", sessions: -1 };
      } catch (error) {
        return {
          error: String(error),
          sessions: (await window.reels!.workbench!.state()).sessions.length,
        };
      }
    });
    expect(result.error).not.toBe("accepted");
    expect(result.error).toMatch(/kind|Invalid/);
    expect(result.sessions).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("workbench-tools-default.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("PTY edits source in the selected temporary checkout", async () => {
  const profile = await makeProfile();
  const workspace = join(profile, "한글 source checkout");
  let app;
  try {
    await mkdir(workspace);
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "reels-dashboard",
        scripts: { dev: "vite", typecheck: "tsc" },
      }),
    );
    await writeFile(
      join(workspace, "sentinel.ts"),
      "export const value = 'before';\n",
    );
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, workspace);
    const session = await page.evaluate(async () => {
      await window.reels!.workbench!.chooseWorkspace();
      return window.reels!.workbench!.start({ kind: "shell" });
    });
    expect(session.cwd).toBe(await realpath(workspace));
    await page.evaluate(async (id) => {
      await window.reels!.workbench!.write(
        id,
        'printf "%s\\n" "export const value = \'after\';" > sentinel.ts\r',
      );
    }, session.id);
    await expect
      .poll(() => readFile(join(workspace, "sentinel.ts"), "utf8"))
      .toBe("export const value = 'after';\n");
    await page.evaluate(
      async (id) => window.reels!.workbench!.stop(id),
      session.id,
    );
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("the settings toggle enables the terminal without REELS_DEV_MODE after a restart", async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: undefined });
    let page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "터미널", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    const toggle = page.getByRole("checkbox", { name: "터미널 사용" });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect(page.getByRole("button", { name: "지금 다시 시작" })).toBeVisible();
    expect(
      JSON.parse(await readFile(join(profile, "terminal-settings.json"), "utf8")),
    ).toEqual({ enabled: true });
    await closeApp(app);

    app = await launchApp(profile, true, { REELS_DEV_MODE: undefined });
    page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "터미널", exact: true })).toBeVisible();
    expect(await page.evaluate(() => typeof window.reels!.workbench)).toBe("object");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "터미널 사용" })).toBeChecked();
    await expect(page.getByRole("button", { name: "지금 다시 시작" })).toHaveCount(0);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
