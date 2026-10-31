import { expect, test } from "@playwright/test";
import { makeProfile, launchApp, closeApp, cleanProfile } from "./helpers";

test("desktop toolbar reserves window controls and keeps terminal separate from content navigation", async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    const toolbar = page.getByRole("banner", { name: "작업공간 도구" });
    await expect(toolbar).toHaveClass(/native-toolbar/);
    expect(
      await toolbar.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("drag");
    const history = toolbar.getByRole("button", {
      name: "히스토리",
      exact: true,
    });
    expect(
      await history.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    expect(
      (await toolbar
        .getByRole("button", { name: "뒤로", exact: true })
        .boundingBox())!.x,
    ).toBeGreaterThanOrEqual(80);
    await expect(
      page
        .getByRole("navigation")
        .getByRole("button", { name: /터미널|개발|설정/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    await toolbar.getByRole("button", { name: "설정", exact: true }).click();
    await toolbar.getByRole("button", { name: "뒤로", exact: true }).click();
    await expect(page.locator(".editor-workspace")).toBeVisible();
    await toolbar.getByRole("button", { name: "터미널", exact: true }).click();
    const terminal = page.getByRole("region", { name: "터미널", exact: true });
    await expect(terminal).toHaveAttribute("data-drawer-state", "open");
    await expect(
      page.getByRole("button", { name: "새 터미널", exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: info.outputPath("desktop-shell.png") });
    await toolbar.getByRole("button", { name: "터미널", exact: true }).click();
    await expect(terminal).toHaveAttribute("data-drawer-state", "folded");
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
