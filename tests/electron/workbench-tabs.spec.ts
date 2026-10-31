import { test, expect, type Page } from "@playwright/test";
import {
  cleanProfile,
  closeApp,
  launchApp,
  makeProfile,
  pressWorkbenchKey,
} from "./helpers";

const state = (page: Page) =>
  page.evaluate(() => window.reels!.workbench!.state());
const output = (page: Page, id: string) =>
  page.evaluate(
    async (id) => (await window.reels!.workbench!.snapshot(id)).output,
    id,
  );
const write = (page: Page, id: string, text: string) =>
  page.evaluate(
    async ({ id, text }) => window.reels!.workbench!.write(id, text),
    { id, text },
  );

test("drawer shortcuts retain editor content and mounted terminal tabs", async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    const heading = page.getByRole("heading", {
      name: "선택한 장면을 완성해요",
      exact: true,
    });
    await expect(heading).toBeVisible();
    expect(
      await page.evaluate(() => {
        const node = document.querySelector(".editor-workspace");
        (window as any).__editorNode = node;
        return node !== null;
      }),
    ).toBe(true);
    await expect(page.locator("#dev-task")).toBeAttached();
    await pressWorkbenchKey(app, "n");
    const drawer = page.getByRole("region", {
      name: "터미널",
      exact: true,
    });
    await expect(drawer).toHaveAttribute("data-drawer-state", "open");
    await expect(heading).toBeVisible();
    await page
      .getByText("소스 연결 · 개선 요청 · 코딩 도구", { exact: true })
      .click();
    const task = page.locator("#dev-task");
    await task.fill("Keep this request while switching terminal tabs.");
    await pressWorkbenchKey(app, "t");
    await expect.poll(async () => (await state(page)).sessions.length).toBe(1);
    const first = (await state(page)).sessions[0];
    const firstTerminal = page.locator(
      `.dev-terminal[data-session-id="${first.id}"]`,
    );
    await expect(firstTerminal.locator(".xterm-helper-textarea")).toBeFocused();
    expect(
      await page.evaluate((id) => {
        const node = document.querySelector(
          `.dev-terminal[data-session-id="${id}"] .xterm`,
        );
        (window as any).__firstTerminalNode = node;
        return node !== null;
      }, first.id),
    ).toBe(true);
    await pressWorkbenchKey(app, "t");
    await expect.poll(async () => (await state(page)).sessions.length).toBe(2);
    const tabs = page
      .getByRole("tablist", { name: "터미널 세션" })
      .getByRole("tab");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await pressWorkbenchKey(app, "1");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(firstTerminal.locator(".xterm-helper-textarea")).toBeFocused();
    expect(
      await page.evaluate(
        (id) =>
          (window as any).__firstTerminalNode ===
          document.querySelector(
            `.dev-terminal[data-session-id="${id}"] .xterm`,
          ),
        first.id,
      ),
    ).toBe(true);
    await expect(heading).toBeVisible();

    await task.focus();
    const prevented = await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const results: boolean[] = [];
      for (const extra of [{ isAutoRepeat: true }, { isComposing: true }]) {
        for (const [key, code] of [
          ["n", "KeyN"],
          ["t", "KeyT"],
          ["w", "KeyW"],
          ["2", "Digit2"],
        ]) {
          let canceled = false;
          contents.emit(
            "before-input-event",
            {
              preventDefault() {
                canceled = true;
              },
            },
            {
              type: "keyDown",
              key,
              code,
              meta: true,
              control: false,
              alt: false,
              shift: false,
              isAutoRepeat: false,
              isComposing: false,
              ...extra,
            },
          );
          results.push(canceled);
        }
      }
      return results;
    });
    expect(prevented).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect((await state(page)).sessions).toHaveLength(2);
    await expect(drawer).toHaveAttribute("data-drawer-state", "open");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(task).toHaveValue(
      "Keep this request while switching terminal tabs.",
    );
    await page.screenshot({
      path: info.outputPath("workbench-drawer-desktop.png"),
    });

    await pressWorkbenchKey(app, "n");
    await expect(drawer).toHaveAttribute("data-drawer-state", "folded");
    await pressWorkbenchKey(app, "1");
    await expect(
      page.getByRole("heading", { name: "작업의 흐름을 한눈에", exact: true }),
    ).toBeVisible();
    await pressWorkbenchKey(app, "3");
    await expect(heading).toBeVisible();
    await page.screenshot({
      path: info.outputPath("workbench-drawer-folded.png"),
    });
    await pressWorkbenchKey(app, "n");
    await expect(drawer).toHaveAttribute("data-drawer-state", "open");
    expect(
      await page.evaluate(
        () =>
          (window as any).__editorNode ===
          document.querySelector(".editor-workspace"),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        (id) =>
          (window as any).__firstTerminalNode ===
          document.querySelector(
            `.dev-terminal[data-session-id="${id}"] .xterm`,
          ),
        first.id,
      ),
    ).toBe(true);
    await expect(task).toHaveValue(
      "Keep this request while switching terminal tabs.",
    );
    await page
      .getByText("소스 연결 · 개선 요청 · 코딩 도구", { exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Codex 시작", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: info.outputPath("workbench-drawer-default.png"),
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(760, 900),
    );
    await expect(firstTerminal).toBeVisible();
    const terminalBox = await firstTerminal.boundingBox();
    expect(terminalBox).not.toBeNull();
    expect(terminalBox!.height).toBeGreaterThan(100);
    await page.screenshot({
      path: info.outputPath("workbench-drawer-760.png"),
    });
    await page
      .getByText("소스 연결 · 개선 요청 · 코딩 도구", { exact: true })
      .click();
    await page.locator(".dev-drawer-body").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const tabBox = await page
      .getByRole("tablist", { name: "터미널 세션" })
      .boundingBox();
    expect(tabBox).not.toBeNull();
    expect(tabBox!.y).toBeGreaterThan(0);
    expect(tabBox!.y + tabBox!.height).toBeLessThan(
      await page.evaluate(() => innerHeight),
    );
    await page.screenshot({
      path: info.outputPath("workbench-drawer-setup-760.png"),
    });
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("folding blurs the terminal and preserves its PTY size until reopened", async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "대시보드", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".dev-connect code")).toContainText(
      "reels-dashboard",
    );
    await pressWorkbenchKey(app, "t");
    await expect.poll(async () => (await state(page)).sessions.length).toBe(1);
    const session = (await state(page)).sessions[0];
    await write(page, session.id, "printf '__SIZE_BEFORE__ '; stty size\r");
    await expect
      .poll(
        async () =>
          /__SIZE_BEFORE__ (\d+\s+\d+)/.exec(
            await output(page, session.id),
          )?.[1],
      )
      .toBeTruthy();
    const sizeBefore = /__SIZE_BEFORE__ (\d+\s+\d+)/.exec(
      await output(page, session.id),
    )![1];
    await page
      .locator(
        `.dev-terminal[data-session-id="${session.id}"] .xterm-helper-textarea`,
      )
      .focus();
    await pressWorkbenchKey(app, "n");
    const drawer = page.getByRole("region", {
      name: "터미널",
      exact: true,
    });
    await expect(drawer).toHaveAttribute("data-drawer-state", "folded");
    expect(
      await page.evaluate(() =>
        document.activeElement?.classList.contains("xterm-helper-textarea"),
      ),
    ).toBe(false);
    await page.keyboard.type("UNEXPECTED_FOLDED_INPUT");
    await page.keyboard.press("Enter");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1100, 760),
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await write(page, session.id, "printf '__SIZE_AFTER__ '; stty size\r");
    await expect
      .poll(
        async () =>
          /__SIZE_AFTER__ (\d+\s+\d+)/.exec(
            await output(page, session.id),
          )?.[1],
      )
      .toBe(sizeBefore);
    expect(await output(page, session.id)).not.toContain(
      "UNEXPECTED_FOLDED_INPUT",
    );
    await pressWorkbenchKey(app, "n");
    await expect(drawer).toHaveAttribute("data-drawer-state", "open");
    await expect(
      page.locator(
        `.dev-terminal[data-session-id="${session.id}"] .xterm-helper-textarea`,
      ),
    ).toBeFocused();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("Cmd W closes the selected process and tab, then hides a folded drawer without killing remaining sessions", async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "대시보드", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".dev-connect code")).toContainText(
      "reels-dashboard",
    );
    await pressWorkbenchKey(app, "t");
    await expect.poll(async () => (await state(page)).sessions.length).toBe(1);
    const first = (await state(page)).sessions[0];
    await pressWorkbenchKey(app, "t");
    await expect.poll(async () => (await state(page)).sessions.length).toBe(2);
    const second = (await state(page)).sessions[1];
    await write(page, second.id, "printf '__TAB_PID__=%s\\n' $$\r");
    await expect
      .poll(
        async () =>
          /__TAB_PID__=(\d+)/.exec(await output(page, second.id))?.[1],
      )
      .toBeTruthy();
    const pid = Number(
      /__TAB_PID__=(\d+)/.exec(await output(page, second.id))![1],
    );
    await page
      .locator(
        `.dev-terminal[data-session-id="${second.id}"] .xterm-helper-textarea`,
      )
      .focus();
    await pressWorkbenchKey(app, "w");
    await expect
      .poll(async () => (await state(page)).sessions.map((s) => s.id))
      .toEqual([first.id]);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    await pressWorkbenchKey(app, "n");
    await expect(
      page.getByRole("region", { name: "터미널", exact: true }),
    ).toHaveAttribute("data-drawer-state", "folded");
    await pressWorkbenchKey(app, "w");
    expect((await state(page)).sessions.map((s) => s.id)).toEqual([first.id]);
    expect(
      await app.evaluate(({ BrowserWindow }) => ({
        count: BrowserWindow.getAllWindows().length,
        visible: BrowserWindow.getAllWindows()[0]!.isVisible(),
      })),
    ).toEqual({ count: 1, visible: false });
    await pressWorkbenchKey(app, "n");
    await pressWorkbenchKey(app, "w");
    await expect.poll(async () => (await state(page)).sessions.length).toBe(0);
    await pressWorkbenchKey(app, "w");
    await expect(
      page.locator('[aria-label="터미널"][data-drawer-state]'),
    ).toHaveAttribute("data-drawer-state", "closed");
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("normal mode does not install workbench keyboard shortcuts", async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: undefined });
    const page = await app.firstWindow();
    const heading = page.getByRole("heading", {
      name: "작업의 흐름을 한눈에",
      exact: true,
    });
    await expect(heading).toBeVisible();
    await pressWorkbenchKey(app, "n");
    await pressWorkbenchKey(app, "t");
    await pressWorkbenchKey(app, "3");
    await expect(heading).toBeVisible();
    await expect(page.locator("[data-drawer-state]")).toHaveCount(0);
    expect(await page.evaluate(() => window.reels!.workbench)).toBeUndefined();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
