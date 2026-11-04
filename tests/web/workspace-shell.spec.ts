import { expect, test } from "@playwright/test";

test("compact shell provides navigation history, search and settings without losing editor state", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?demo=1");
  const toolbar = page.getByRole("banner", { name: "작업공간 도구" });
  await expect(
    toolbar.getByRole("button", { name: "뒤로", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".brand, .topbar")).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "설정", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "개발 작업공간", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await page.locator(".editor-workspace").evaluate((el) => {
    (window as any).__shellEditor = el;
  });
  await toolbar.getByRole("button", { name: "설정", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Photos 연결", exact: true }),
  ).toBeVisible();
  await toolbar.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page.locator(".editor-workspace")).toBeVisible();
  expect(
    await page
      .locator(".editor-workspace")
      .evaluate((el) => (window as any).__shellEditor === el),
  ).toBe(true);
  await toolbar.getByRole("button", { name: "앞으로", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Photos 연결", exact: true }),
  ).toBeVisible();
  await toolbar.getByRole("button", { name: "히스토리", exact: true }).click();
  const history = page.getByRole("dialog", { name: "최근 화면 히스토리" });
  await history.getByRole("button", { name: "대시보드" }).click();
  await expect(history).not.toBeVisible();
  await toolbar.getByRole("button", { name: "검색", exact: true }).click();
  const search = page.getByRole("dialog", { name: "작업공간 검색" });
  const input = search.getByRole("textbox", { name: "메뉴·콘텐츠 검색" });
  await expect(input).toBeFocused();
  await input.fill("no-such-content-1234");
  await expect(search.getByRole("status")).toHaveText("검색 결과가 없어요.");
  await input.fill("도쿄");
  await search.getByRole("button", { name: /도쿄의 오후 산책/ }).click();
  const project = page.getByRole("dialog", { name: "콘텐츠 기록" });
  await expect(project.getByLabel("콘텐츠 제목", { exact: true })).toHaveValue(
    "도쿄의 오후 산책",
  );
  await page.keyboard.press("Control+k");
  await expect(search).not.toBeVisible();
  await project.getByRole("button", { name: "취소", exact: true }).click();
  await page.keyboard.press("Control+k");
  await expect(search).toBeVisible();
  await input.fill("영상 편집");
  await search.getByRole("button", { name: /영상 편집/ }).click();
  await expect(page.locator(".editor-workspace")).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "앞으로", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "대시보드", exact: true }).click();
  await page.screenshot({ path: info.outputPath("shell-1600.png") });
  const settingBox = await toolbar
    .getByRole("button", { name: "설정", exact: true })
    .boundingBox();
  expect(settingBox!.x).toBeGreaterThan(1450);
  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      toolbar.getByRole("button", { name: "설정", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`shell-${width}.png`) });
  }
});

test("search caps each group, reaches overflow by query and keeps keyboard focus predictable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "reels-dashboard-demo-v1",
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-11-02T00:00:00.000Z",
        projects: Array.from({ length: 12 }, (_, index) => ({
          id: `keyboard-project-${index}`,
          title: `검색용 콘텐츠 ${index + 1}`,
          date: "2026-11-02",
          stage: "editing",
          nextAction: "검토",
          publicURL: "",
          shared: false,
        })),
      }),
    );
  });
  await page.goto("/?demo=1");
  const searchButton = page
    .getByRole("banner", { name: "작업공간 도구" })
    .getByRole("button", { name: "검색", exact: true });
  await searchButton.click();
  const search = page.getByRole("dialog", { name: "작업공간 검색" });
  const input = search.getByRole("textbox", { name: "메뉴·콘텐츠 검색" });
  await expect(
    search.getByText("콘텐츠 12개 중 8개를 표시해요. 검색어로 좁혀 주세요."),
  ).toBeVisible();
  await expect(
    search.getByRole("button", { name: /검색용 콘텐츠/ }),
  ).toHaveCount(8);
  expect(
    await search.locator(".shell-results button").count(),
  ).toBeLessThanOrEqual(16);
  const first = search.locator(".shell-results button").first();
  const last = search.locator(".shell-results button").last();
  await input.press("ArrowUp");
  await expect(last).toBeFocused();
  await last.press("ArrowDown");
  await expect(input).toBeFocused();
  await input.press("ArrowDown");
  await expect(first).toBeFocused();
  await first.press("End");
  await expect(last).toBeFocused();
  await last.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).not.toBeVisible();
  await expect(searchButton).toBeFocused();

  await page.keyboard.press("Control+k");
  await input.fill("검색용 콘텐츠 12");
  await expect(
    search.getByRole("button", { name: /검색용 콘텐츠/ }),
  ).toHaveCount(1);
  await input.press("Enter");
  const project = page.getByRole("dialog", { name: "콘텐츠 기록" });
  await expect(project.getByLabel("콘텐츠 제목", { exact: true })).toHaveValue(
    "검색용 콘텐츠 12",
  );
  await expect(search).not.toBeVisible();
  await project.getByRole("button", { name: "취소", exact: true }).click();
  await page.keyboard.press("Control+k");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
});

test("a queued native close event cannot dismiss a reopened search", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const searchButton = page
    .getByRole("banner", { name: "작업공간 도구" })
    .getByRole("button", { name: "검색", exact: true });
  await searchButton.click();
  const search = page.getByRole("dialog", { name: "작업공간 검색" });
  // close() queues a native close event. Reopen in the next microtask, before
  // that event is delivered, to reproduce fast Escape/shortcut interaction.
  await search.evaluate(async (element) => {
    const closed = new Promise<void>((resolve) => {
      element.addEventListener(
        "close",
        () => requestAnimationFrame(() => resolve()),
        { once: true },
      );
    });
    element
      .querySelector<HTMLButtonElement>('[aria-label="검색·히스토리 닫기"]')!
      .click();
    await Promise.resolve();
    document
      .querySelector<HTMLButtonElement>(
        '.workspace-toolbar [aria-label="검색"]',
      )!
      .click();
    await closed;
  });
  const input = search.getByRole("textbox", { name: "메뉴·콘텐츠 검색" });
  await expect(input).toBeVisible();
  await input.fill("영상 편집");
  await input.press("Enter");
  await expect(page.locator(".editor-workspace")).toBeVisible();
});

test("holding Cmd reveals shortcut hints only while held and only for live shortcuts", async ({
  page,
}) => {
  const hints = page.locator("[data-shortcut-hint]");
  await page.goto("/?demo=1");
  await expect(
    page.getByRole("button", { name: "대시보드", exact: true }),
  ).toBeVisible();
  await expect(hints).toHaveCount(0);
  await page.keyboard.down("Meta");
  // Without the dev workbench bridge only the renderer search shortcut is live.
  await expect(page.locator('[data-shortcut-hint="quickOpen"]')).toHaveText("⌘K");
  await expect(hints).toHaveCount(1);
  await page.keyboard.up("Meta");
  await expect(hints).toHaveCount(0);

  await page.goto("/tests/web/fixtures/ui-inspector.html?enabled=1");
  const nav = page.getByRole("navigation", { name: "주요 메뉴" });
  await expect(nav.getByRole("button", { name: "대시보드", exact: true })).toBeVisible();
  await page.keyboard.down("Meta");
  await expect(page.locator('[data-shortcut-hint="quickOpen"]')).toHaveCount(1);
  await expect(page.locator('[data-shortcut-hint="inspectUi"]')).toHaveText("⇧⌘C");
  await expect(page.locator('[data-shortcut-hint="toggleDrawer"]')).toHaveText("⌘N");
  // The drawer is closed, so ⌘1-9 targets the sidebar screens.
  const screens = await nav.getByRole("button").count();
  await expect(nav.locator("[data-shortcut-hint]")).toHaveCount(Math.min(screens, 9));
  await expect(
    nav.getByRole("button", { name: "대시보드", exact: true }).locator("[data-shortcut-hint]"),
  ).toHaveText("⌘1");
  await page.keyboard.up("Meta");
  await expect(hints).toHaveCount(0);

  await page.keyboard.down("Meta");
  await expect(page.locator('[data-shortcut-hint="quickOpen"]')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(hints).toHaveCount(0);
  await page.keyboard.up("Meta");
  await expect(hints).toHaveCount(0);
});

test("Cmd+[ / Cmd+] and mouse side buttons step the same history as the toolbar buttons", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const toolbar = page.getByRole("banner", { name: "작업공간 도구" });
  const backButton = toolbar.getByRole("button", { name: "뒤로", exact: true });
  const forwardButton = toolbar.getByRole("button", {
    name: "앞으로",
    exact: true,
  });
  const settings = page.getByRole("heading", {
    name: "Photos 연결",
    exact: true,
  });
  const editor = page.locator(".editor-workspace");
  await expect(
    page.getByRole("button", { name: "대시보드", exact: true }),
  ).toBeVisible();
  await expect(backButton).toBeDisabled();

  // At the start of history ⌘[ is a no-op and no goBack hint is revealed.
  await page.keyboard.press("Meta+BracketLeft");
  await expect(backButton).toBeDisabled();
  await page.keyboard.down("Meta");
  await expect(page.locator('[data-shortcut-hint="quickOpen"]')).toHaveCount(1);
  await expect(page.locator('[data-shortcut-hint="goBack"]')).toHaveCount(0);
  await expect(page.locator('[data-shortcut-hint="goForward"]')).toHaveCount(0);
  await page.keyboard.up("Meta");

  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await expect(editor).toBeVisible();
  await toolbar.getByRole("button", { name: "설정", exact: true }).click();
  await expect(settings).toBeVisible();

  await page.keyboard.down("Meta");
  await expect(backButton.locator('[data-shortcut-hint="goBack"]')).toHaveText("⌘[");
  await expect(page.locator('[data-shortcut-hint="goForward"]')).toHaveCount(0);
  await page.keyboard.up("Meta");

  await page.keyboard.press("Meta+BracketLeft");
  await expect(editor).toBeVisible();
  await expect(forwardButton).toBeEnabled();
  await page.keyboard.down("Meta");
  await expect(
    forwardButton.locator('[data-shortcut-hint="goForward"]'),
  ).toHaveText("⌘]");
  await page.keyboard.up("Meta");
  await page.keyboard.press("Meta+BracketRight");
  await expect(settings).toBeVisible();
  await expect(forwardButton).toBeDisabled();

  const mouseUp = (button: number) =>
    page.evaluate((button) => {
      const event = new MouseEvent("mouseup", {
        button,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }, button);
  expect(await mouseUp(3)).toBe(true);
  await expect(editor).toBeVisible();
  expect(await mouseUp(4)).toBe(true);
  await expect(settings).toBeVisible();
  // At the end of history the forward button is not live, so it falls through.
  expect(await mouseUp(4)).toBe(false);
  await expect(settings).toBeVisible();
  expect(await mouseUp(3)).toBe(true);
  expect(await mouseUp(3)).toBe(true);
  await expect(backButton).toBeDisabled();
  expect(await mouseUp(3)).toBe(false);
  await expect(forwardButton).toBeEnabled();
});

test("history keys stay out of the open content form, and a held history key steps once", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const toolbar = page.getByRole("banner", { name: "작업공간 도구" });
  const backButton = toolbar.getByRole("button", { name: "뒤로", exact: true });
  const dashboard = page.getByRole("heading", { name: "작업의 흐름을 한눈에", exact: true });
  const editor = page.locator(".editor-workspace");
  const settings = page.getByRole("heading", { name: "Photos 연결", exact: true });
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "대시보드", exact: true }).click();
  await expect(dashboard).toBeVisible();
  await expect(backButton).toBeEnabled();

  type Synthetic = { mouse?: number; repeat?: boolean };
  const synthetic = (init: Synthetic): Promise<boolean> =>
    page.evaluate(({ mouse, repeat }: Synthetic) => {
      const event =
        mouse !== undefined
          ? new MouseEvent("mouseup", { button: mouse, bubbles: true, cancelable: true })
          : new KeyboardEvent("keydown", {
              code: "BracketLeft",
              key: "[",
              metaKey: true,
              repeat,
              bubbles: true,
              cancelable: true,
            });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
  const back: Synthetic = {};

  await page.getByRole("button", { name: "새 콘텐츠", exact: true }).click();
  const form = page.getByRole("dialog", { name: "콘텐츠 기록" });
  await expect(form).toBeVisible();
  // Not live while the form is open: the keys fall through and the screen stays.
  expect(await synthetic(back)).toBe(false);
  expect(await synthetic({ mouse: 3 })).toBe(false);
  await expect(form).toBeVisible();
  await expect(dashboard).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);

  // A live key's auto-repeat is consumed (no browser fallback) but does not step again.
  await toolbar.getByRole("button", { name: "설정", exact: true }).click();
  await expect(settings).toBeVisible();
  expect(await synthetic(back)).toBe(true);
  await expect(dashboard).toBeVisible();
  expect(await synthetic({ ...back, repeat: true })).toBe(true);
  await expect(dashboard).toBeVisible();
  await expect(editor).not.toBeVisible();
});

test("the compact toolbar hides static key labels but keeps Cmd-hold hints visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto("/?demo=1");
  const search = page
    .getByRole("banner", { name: "작업공간 도구" })
    .getByRole("button", { name: "검색", exact: true });
  await expect(search).toBeVisible();
  await expect(search.locator("kbd:not(.shortcut-hint)")).toBeHidden();
  await page.keyboard.down("Meta");
  await expect(search.locator('[data-shortcut-hint="quickOpen"]')).toBeVisible();
  await page.keyboard.up("Meta");
});
