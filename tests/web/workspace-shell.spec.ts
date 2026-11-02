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
