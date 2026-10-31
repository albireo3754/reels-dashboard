import { test, expect } from "@playwright/test";

test("route map selects chronological pins, filters assets and preserves uncertain evidence", async ({ page }, info) => {
  await page.goto("/?demo=1");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "도쿄의 오후 산책", exact: true }) });
  await card.getByRole("button", { name: "촬영 지도 · 동선 보기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "도쿄의 오후 산책 촬영 지도", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("route-map-initial.png") });
  await expect(dialog.getByRole("button", { name: /촬영 핀$/ })).toHaveCount(2);
  await expect(dialog.getByRole("heading", { name: "walk.mp4", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "다음 촬영", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "cover.png", exact: true })).toBeVisible();
  await dialog.getByLabel("촬영 종류").selectOption("video");
  await expect(dialog.getByRole("heading", { name: "walk.mp4", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "다음 촬영", exact: true }).click();
  await expect(dialog.getByText("이 촬영분의 원본은 아직 연결되지 않았어요.", { exact: false })).toBeVisible();
  await expect(dialog.locator(".route-map-list button")).toHaveCount(2);
  await dialog.getByLabel("위치가 불확실한 핀 표시").check();
  await expect(dialog.getByRole("button", { name: /촬영 핀$/ })).toHaveCount(2);
  await dialog.screenshot({ path: info.outputPath("route-map-desktop.png") });
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await expect(card.getByRole("button", { name: "촬영 지도 · 동선 보기", exact: true })).toBeFocused();
});

test("route opens authorized original playback and remains usable on mobile", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/?demo=1");
  await page.getByRole("button", { name: "촬영 지도 · 동선 보기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "도쿄의 오후 산책 촬영 지도", exact: true });
  await dialog.getByRole("button", { name: "선택한 촬영분 열기", exact: true }).click();
  const video = dialog.getByLabel("walk.mp4 재생");
  await expect.poll(() => video.evaluate(n => (n as HTMLVideoElement).readyState)).toBeGreaterThan(0);
  await video.evaluate(n => (n as HTMLVideoElement).play());
  await expect.poll(() => video.evaluate(n => (n as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  expect(await dialog.evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
  await dialog.screenshot({ path: info.outputPath("route-map-mobile.png") });
  await dialog.getByRole("button", { name: "촬영 지도 닫기", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
});
