import { expect, test } from "@playwright/test";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test("background QA keeps windows hidden and unfocusable while rendering", async () => {
  test.skip(process.env.REELS_ELECTRON_HEADED === "1", "Background mode only.");
  const profile = await makeProfile();
  const instance = await launchApp(profile);
  try {
    const page = await instance.firstWindow();
    await expect(page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("button", { name: "대시보드", exact: true })).toBeVisible();
    const windowState = () => instance.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      return {
        visible: window.isVisible(),
        focused: window.isFocused(),
        focusable: window.isFocusable(),
      };
    });
    expect(await windowState()).toEqual({ visible: false, focused: false, focusable: false });
    await instance.evaluate(({ app }) => {
      app.emit("activate");
      app.emit("second-instance", {}, [], "");
    });
    expect(await windowState()).toEqual({ visible: false, focused: false, focusable: false });
    expect((await page.screenshot()).length).toBeGreaterThan(1000);
  } finally {
    await closeApp(instance);
    await cleanProfile(profile);
  }
});
