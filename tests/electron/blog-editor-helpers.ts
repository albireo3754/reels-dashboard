import { expect, type ElectronApplication, type Frame, type Locator, type Page } from "@playwright/test";

/** BrowserWindow count in the main process (the blog editor must not add one). */
export const windowCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** The blog tab's iframe for an opened project. */
export const editorIframe = (main: Page, projectId: string): Locator =>
  main.locator(`iframe.blog-editor-frame[data-blog-editor="${projectId}"]`);

/**
 * Clicks 프로젝트 열기 (in the given card, or the only one) and returns the embedded
 * editor document once it shows its saved state. Asserts no window was created.
 */
export async function openBlogEditor(
  app: ElectronApplication,
  main: Page,
  projectId: string,
  card?: Locator,
): Promise<Frame> {
  const before = await windowCount(app);
  const iframe = editorIframe(main, projectId);
  // On a GitHub macOS runner the click on 프로젝트 열기 was sometimes delivered with no click event on
  // the button (CI diagnostic 2026-11-25), so retry until the tab shows. Opening an open project reuses it.
  await expect(async () => {
    await main.getByRole("tab", { name: "프로젝트", exact: true }).click();
    await (card ?? main).getByRole("button", { name: "프로젝트 열기", exact: true }).click();
    await expect(iframe).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 45_000 });
  const frame = await (await iframe.elementHandle())!.contentFrame();
  if (!frame) throw new Error("embedded editor frame missing");
  await expect(frame.locator("#ce-save-status")).toContainText("✓ 저장 완료", { timeout: 15000 });
  expect(await windowCount(app)).toBe(before);
  return frame;
}

/** Sizes the dashboard window so the embedded editor document gets about width × height. */
export async function setEditorViewport(main: Page, projectId: string, width: number, height: number) {
  const iframe = editorIframe(main, projectId);
  let size = main.viewportSize() ?? { width: 1600, height: 1000 };
  for (let i = 0; i < 2; i++) {
    const box = (await iframe.boundingBox())!;
    size = {
      width: Math.round(size.width + width - box.width),
      height: Math.round(size.height + height - box.height),
    };
    await main.setViewportSize(size);
    // The frame height follows the window (resize listener + 100vh).
    await expect.poll(async () => Math.round((await iframe.boundingBox())!.width)).toBeGreaterThan(0);
  }
}

/** Closes an editor tab with its × button; the document tab (role=tab) disappears. */
export async function closeEditorTab(main: Page, title: string) {
  await main.getByRole("button", { name: `${title} 탭 닫기`, exact: true }).click();
  await expect(main.getByRole("tab", { name: title, exact: true })).toHaveCount(0);
}
