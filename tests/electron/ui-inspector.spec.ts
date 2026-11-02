import { test, expect } from "@playwright/test";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test("native inspection shortcut opens a draft without starting a terminal", async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "화면 검사", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.title = "Inspection keyboard preview";
      frame.srcdoc = "<button>Preview action</button>";
      document.body.append(frame);
    });
    const preview = page
      .frameLocator('iframe[title="Inspection keyboard preview"]')
      .getByRole("button", { name: "Preview action" });
    await preview.focus();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      "IFRAME",
    );
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith("file:"),
      )!;
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "C",
        modifiers: ["meta", "shift"],
      });
      window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "C",
        modifiers: ["meta", "shift"],
      });
    });
    await expect(page.locator(".ui-inspector-banner")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "검사 끝내기 · Esc" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ui-inspector-banner")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      "IFRAME",
    );
    await page.getByRole("button", { name: "화면 검사", exact: true }).click();
    await expect(page.locator(".ui-inspector-banner")).toBeVisible();
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "화면 수정 요청" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("선택 요소 코드 위치")).toContainText(
      "src/renderer/App.tsx",
    );
    await dialog
      .getByRole("textbox", { name: "수정할 내용" })
      .fill("합성 화면 수정 요청");
    await dialog
      .getByRole("button", { name: "개선 요청에 추가", exact: true })
      .click();
    await expect(page.locator("#dev-task")).toHaveValue(/합성 화면 수정 요청/);
    expect(
      await page.evaluate(
        async () => (await window.reels!.workbench!.state()).sessions,
      ),
    ).toHaveLength(0);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
