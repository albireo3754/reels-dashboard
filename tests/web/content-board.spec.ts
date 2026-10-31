import { test, expect } from "@playwright/test";
test("board exposes progress and thumbnails, plays selected media and navigates footage folders", async ({
  page,
}, info) => {
  await page.goto("/?demo=1");
  const card = page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "도쿄의 오후 산책", exact: true }),
    });
  await expect(card.getByLabel("현재 진행: 편집 중")).toBeVisible();
  await expect(
    card.getByRole("img", { name: "산책 표지 썸네일" }).first(),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "산책 편집 시안 미리보기", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "도쿄의 오후 산책 자료와 진행사항",
  });
  await expect(dialog).toContainText("첫 장면과 장소 안내를 확인해요.");
  const video = dialog.getByLabel("산책 편집 시안 재생");
  await expect
    .poll(() => video.evaluate((n) => (n as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  await video.evaluate((n) => (n as HTMLVideoElement).play());
  await expect
    .poll(() => video.evaluate((n) => (n as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0);
  await dialog
    .getByRole("button", { name: "산책 표지 보기", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "산책 표지", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator("video")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "촬영 원본 폴더 열기", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "산책 장면.mp4 보기", exact: true })
    .click();
  await expect(dialog.getByLabel("산책 장면.mp4 재생")).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("content-media-viewer.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "산책 편집 시안 미리보기", exact: true }),
  ).toBeFocused();
});
test("content board and viewer fit mobile, and shared web never requests local media", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "도쿄의 오후 산책 미디어 보기", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "미디어 닫기", exact: true }).click();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /미디어 보기/ }).filter({ visible: true }),
  ).toHaveCount(0);
});
