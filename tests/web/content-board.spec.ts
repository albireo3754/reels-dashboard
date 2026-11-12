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
  await expect(dialog.getByText("원본 파일을 그대로 재생해요.")).toBeVisible();
  await dialog
    .getByRole("button", { name: "산책 표지 보기", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "산책 표지", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator("video")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "촬영 지도 보기", exact: true })
    .click();
  await expect(dialog.getByLabel("촬영 지도 본문")).toContainText(
    "route-map-data.json의 본문이 여기에 표시돼요.",
  );
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
test("documents open as Markdown, text or a blog post, and folders read as directories", async ({
  page,
}, info) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "도쿄의 오후 산책 미디어 보기", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "도쿄의 오후 산책 자료와 진행사항",
  });
  const top = dialog.getByRole("button", {
    name: "촬영 원본 폴더 열기",
    exact: true,
  });
  await expect(top).toHaveClass(/folder/);
  await expect(top).toContainText("폴더 · 열기 ›");
  await top.click();
  const grid = dialog.locator(".board-file-grid > button");
  // Folders come first and carry the folder styling; files do not.
  await expect(grid.first()).toHaveAccessibleName("추가 촬영 폴더 열기");
  await expect(grid.first()).toHaveClass(/folder/);
  await expect(
    dialog.getByRole("button", { name: "대본.md 보기", exact: true }),
  ).not.toHaveClass(/folder/);

  await dialog.getByRole("button", { name: "대본.md 보기", exact: true }).click();
  const modes = dialog.getByRole("group", { name: "문서 보기 방식" });
  await expect(modes.getByRole("button", { name: "Markdown" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const body = dialog.getByLabel("대본.md 본문");
  await expect(body.getByRole("heading", { name: "예시 대본" })).toBeVisible();
  await expect(body.locator("strong", { hasText: "첫 장면" })).toBeVisible();
  // Frontmatter is folded away instead of rendered as a heading.
  await expect(body.getByText("문서 속성")).toBeVisible();
  await modes.getByRole("button", { name: "텍스트" }).click();
  await expect(dialog.getByLabel("대본.md 본문")).toContainText("# 예시 대본");
  await expect(dialog.getByLabel("대본.md 본문")).toContainText("**첫 장면**");
  await modes.getByRole("button", { name: "블로그" }).click();
  await expect(
    dialog
      .getByLabel("대본.md 블로그 미리보기")
      .getByRole("heading", { name: "예시 대본" }),
  ).toBeVisible();

  await dialog
    .getByRole("button", { name: "블로그 원고.md 보기", exact: true })
    .click();
  await expect(
    dialog
      .getByRole("group", { name: "문서 보기 방식" })
      .getByRole("button", { name: "블로그" }),
  ).toHaveAttribute("aria-pressed", "true");
  const frame = dialog.getByLabel("블로그 원고.md 블로그 미리보기");
  await expect(
    frame.getByRole("heading", { name: "도쿄 오후 산책 기록" }),
  ).toBeVisible();
  await expect(frame.getByText("벚꽃이 한가득")).toHaveCSS("font-weight", "700");
  await expect(
    frame.getByRole("heading", { name: "걷기 좋은 길" }),
  ).toBeVisible();
  await expect(frame.getByRole("img", { name: "공원 산책로" })).toHaveAttribute(
    "src",
    /^data:image/,
  );
  // The post keeps its own styles: the app's markdown styles do not leak in.
  await expect(frame.getByRole("heading", { name: "도쿄 오후 산책 기록" })).toHaveCSS(
    "font-size",
    "28px",
  );
  await dialog.screenshot({ path: info.outputPath("document-blog-view.png") });
  await dialog
    .getByRole("group", { name: "문서 보기 방식" })
    .getByRole("button", { name: "텍스트" })
    .click();
  await expect(dialog.getByLabel("블로그 원고.md 본문")).toContainText(
    "⟦벚꽃이 한가득⟧¹",
  );

  await grid.first().click();
  await expect(dialog.getByText("이 폴더에는 표시할 자료가 없어요.")).toBeVisible();
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
test("a video the renderer cannot play falls back to a playback copy", async ({
  page,
}) => {
  await page.goto("/?demo=1&demoPlaybackError=1");
  const card = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "도쿄의 오후 산책", exact: true }),
  });
  await card
    .getByRole("button", { name: "산책 편집 시안 미리보기", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "도쿄의 오후 산책 자료와 진행사항",
  });
  await expect(
    dialog.getByRole("status").filter({ hasText: "재생용 사본을 준비하고 있어요" }),
  ).toBeVisible();
  const video = dialog.getByLabel("산책 편집 시안 재생");
  await expect
    .poll(() => video.evaluate((n) => (n as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  await video.evaluate((n) => (n as HTMLVideoElement).play());
  await expect
    .poll(() => video.evaluate((n) => (n as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0);
  await expect(
    dialog.getByText("재생용 사본으로 재생해요. 원본은 그대로 유지돼요."),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
