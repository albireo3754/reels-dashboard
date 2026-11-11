import { test, expect, type Page } from "@playwright/test";
import {
  cleanProfile,
  closeApp,
  launchApp,
  makeProfile,
} from "./helpers";

const state = (page: Page) =>
  page.evaluate(() => window.reels!.workbench!.state());
const resize = (app: Awaited<ReturnType<typeof launchApp>>, width: number) =>
  app.evaluate(
    ({ BrowserWindow }, width) =>
      BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
    width,
  );
const box = async (locator: ReturnType<Page["locator"]>) => {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
};

/** The one-line bar: tabs, +, ▾ share a row and the right-hand actions stay on screen. */
async function expectOneLineBar(page: Page) {
  const bar = page.getByTestId("dev-tabbar");
  const barBox = await box(bar);
  expect(barBox.height).toBeLessThan(60);
  const plus = await box(page.getByTestId("dev-new-tab"));
  const menu = await box(page.getByTestId("dev-new-menu"));
  const fold = await box(page.getByRole("button", { name: "터미널 접기" }));
  const close = await box(page.getByRole("button", { name: "터미널 닫기" }));
  const width = await page.evaluate(() => innerWidth);
  for (const item of [plus, menu, fold, close]) {
    expect(item.y).toBeGreaterThanOrEqual(barBox.y);
    expect(item.y + item.height).toBeLessThanOrEqual(barBox.y + barBox.height + 1);
    expect(item.x + item.width).toBeLessThanOrEqual(width);
  }
  expect(menu.x).toBeGreaterThan(plus.x);
  expect(close.x).toBeGreaterThan(fold.x);
  const tabs = page.getByRole("tab");
  const count = await tabs.count();
  if (count) {
    const last = await box(tabs.nth(count - 1));
    // + and ▾ sit after the tabs on the same row, never wrapped below them.
    expect(plus.y + plus.height / 2).toBeGreaterThan(last.y);
    expect(plus.y + plus.height / 2).toBeLessThan(last.y + last.height + 8);
  }
}

test("empty panel offers terminal, Codex and Claude, with the settings behind a gear", async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "터미널", exact: true }).click();
    const drawer = page.getByRole("region", { name: "터미널", exact: true });
    await expect(drawer).toHaveAttribute("data-drawer-state", "open");
    await expect(page.getByRole("tab")).toHaveCount(0);
    const empty = page.getByTestId("dev-empty");
    await expect(
      empty.getByRole("button", { name: "터미널 열기", exact: true }),
    ).toBeEnabled();
    await expect(
      empty.getByRole("button", { name: "Codex 열기", exact: true }),
    ).toBeEnabled();
    await expect(
      empty.getByRole("button", { name: "Claude 열기", exact: true }),
    ).toBeEnabled();
    // The old header button row and the always-visible explainer are gone.
    await expect(
      page.getByRole("button", { name: /^(Codex|Claude Code) 시작/ }),
    ).toHaveCount(0);
    await expect(drawer).not.toContainText("세션을 시작하면 이곳에 터미널이 열려요");
    await expectOneLineBar(page);

    // Settings: collapsed by default, one toggle, every old control reachable.
    const gear = page.getByTestId("dev-settings-toggle");
    await expect(gear).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("dev-settings")).toBeHidden();
    await gear.click();
    await expect(gear).toHaveAttribute("aria-expanded", "true");
    const settings = page.getByTestId("dev-settings");
    await expect(settings).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "소스 폴더 연결" }),
    ).toBeVisible();
    // Prompt copy moved into the composer's ⋯ menu; it stays reachable there.
    await settings.getByRole("button", { name: "요청 더 보기" }).click();
    await expect(
      settings.getByRole("menuitem", { name: "현재 세션용 프롬프트 복사" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(settings.getByRole("button", { name: /세션 시작$/ })).toBeVisible();
    await expect(settings.getByLabel(/개선 요청/)).toBeVisible();
    await expect(settings.getByTestId("dev-backend-setting")).toBeVisible();
    await expect(settings.getByRole("group", { name: "개선 단계" })).toBeVisible();
    await expect(
      settings.getByRole("combobox", { name: "코딩 도구" }).locator("option"),
    ).toHaveText(["Codex", "Claude Code"]);
    await page.screenshot({
      path: info.outputPath("tabbar-0-tabs-settings-desktop.png"),
    });
    await gear.click();
    await expect(page.getByTestId("dev-settings")).toBeHidden();

    await page.screenshot({ path: info.outputPath("tabbar-0-tabs-desktop.png") });
    await resize(app, 760);
    await expect(empty).toBeVisible();
    await expectOneLineBar(page);
    await page.screenshot({ path: info.outputPath("tabbar-0-tabs-760.png") });
    await gear.click();
    await page.screenshot({
      path: info.outputPath("tabbar-0-tabs-settings-760.png"),
    });
    await gear.click();

    // The empty-screen terminal button starts a real shell tab.
    await empty.getByRole("button", { name: "터미널 열기", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByTestId("dev-empty")).toHaveCount(0);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("tabs, plus and menu share one row with roles, roving focus and arrow keys", async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "터미널", exact: true }).click();
    const plus = page.getByRole("button", { name: "새 터미널", exact: true });
    for (let i = 1; i <= 3; i++) {
      await plus.click();
      await expect.poll(async () => (await state(page)).sessions.length).toBe(i);
    }
    const tablist = page.getByRole("tablist", { name: "터미널 세션" });
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    // Roving tabindex: only the selected tab is in the tab order.
    await expect(tabs.nth(2)).toHaveAttribute("tabindex", "0");
    await expect(tabs.nth(0)).toHaveAttribute("tabindex", "-1");
    // Each tab names its state and controls a tabpanel.
    await expect(tabs.nth(0)).toContainText("실행 중");
    const panelId = await tabs.nth(0).getAttribute("aria-controls");
    await expect(page.locator(`[id="${panelId}"]`)).toHaveAttribute(
      "role",
      "tabpanel",
    );
    await expectOneLineBar(page);

    await tabs.nth(2).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tabs.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.nth(2)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");

    // ▾ menu: all five choices, arrow navigation, Escape returns focus.
    const toggle = page.getByTestId("dev-new-menu");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "새 세션" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "터미널",
      "Codex 열기",
      "Claude 열기",
      "미리보기 서버",
      "검증 실행",
    ]);
    // The shared menu focuses its first item when opened from the keyboard (a click only opens it).
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Codex 열기" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "검증 실행" })).toBeFocused();
    await page.screenshot({ path: info.outputPath("tabbar-3-tabs-menu-desktop.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    // Outside click closes it too.
    await toggle.click();
    await expect(page.getByRole("menu")).toHaveCount(1);
    await page.getByRole("tabpanel").first().click({ force: true });
    await expect(page.getByRole("menu")).toHaveCount(0);

    // The menu's terminal item opens a fourth tab and closes the menu.
    await toggle.click();
    await page.getByRole("menuitem", { name: "터미널", exact: true }).click();
    await expect.poll(async () => (await state(page)).sessions.length).toBe(4);
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Close: × on a tab and a middle click.
    const sessions = (await state(page)).sessions;
    await page
      .getByRole("button", { name: `${sessions[3].title} 세션 닫기` })
      .last()
      .click();
    await expect.poll(async () => (await state(page)).sessions.length).toBe(3);
    await tabs.nth(0).click({ button: "middle" });
    await expect.poll(async () => (await state(page)).sessions.length).toBe(2);

    await plus.click();
    await expect.poll(async () => (await state(page)).sessions.length).toBe(3);
    await page.screenshot({ path: info.outputPath("tabbar-3-tabs-desktop.png") });
    await resize(app, 760);
    await expectOneLineBar(page);
    await page.screenshot({ path: info.outputPath("tabbar-3-tabs-760.png") });
    await toggle.click();
    await page.screenshot({ path: info.outputPath("tabbar-3-tabs-menu-760.png") });
    await page.keyboard.press("Escape");
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("twelve tabs stay on one row and scroll instead of wrapping", async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "터미널", exact: true }).click();
    const plus = page.getByRole("button", { name: "새 터미널", exact: true });
    for (let i = 1; i <= 12; i++) {
      await plus.click();
      await expect.poll(async () => (await state(page)).sessions.length).toBe(i);
    }
    await expect(page.getByRole("tab")).toHaveCount(12);
    await expectOneLineBar(page);
    await page.screenshot({ path: info.outputPath("tabbar-12-tabs-desktop.png") });
    await resize(app, 760);
    await expectOneLineBar(page);
    // At 760px the tab strip overflows horizontally; keyboard selection scrolls the tab into view.
    await page.getByRole("tab").nth(0).click();
    await page.getByRole("tab").nth(0).focus();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab").nth(11)).toBeFocused();
    const strip = await page
      .getByRole("tablist", { name: "터미널 세션" })
      .evaluate((el) => ({
        overflow: el.scrollWidth > el.clientWidth,
        scrollLeft: el.scrollLeft,
      }));
    expect(strip.overflow).toBe(true);
    expect(strip.scrollLeft).toBeGreaterThan(0);
    const last = await box(page.getByRole("tab").nth(11));
    const strip2 = await box(page.getByRole("tablist", { name: "터미널 세션" }));
    expect(last.x + last.width).toBeLessThanOrEqual(strip2.x + strip2.width + 1);
    await page.screenshot({ path: info.outputPath("tabbar-12-tabs-760.png") });
    // The twelfth session is the limit; the plus button reports it instead of failing silently.
    await plus.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(12);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
