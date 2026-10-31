import { expect, test } from "@playwright/test";
const projects = Array.from({ length: 18 }, (_, i) => ({
  id: `board-${i}`,
  title: `${i % 2 ? "도쿄 산책" : "서울 카페"} ${String(i + 1).padStart(2, "0")}`,
  date: `2026-10-${String(i + 1).padStart(2, "0")}`,
  dateBasis: i % 3 === 0 ? "publication" : i % 3 === 1 ? "capture" : "record",
  stage: i % 3 === 0 ? "published" : i % 3 === 1 ? "review" : "editing",
  nextAction: "표지와 자막 확인",
  publicURL: "",
  shared: false,
}));
test.beforeEach(async ({ page }) => {
  await page.addInitScript((projects) => {
    if (!localStorage.getItem("reels-dashboard-demo-v1"))
      localStorage.setItem(
        "reels-dashboard-demo-v1",
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-10-28T12:00:00Z",
          projects,
        }),
      );
  }, projects);
  await page.goto("/?demo=1");
  await expect(page.locator(".project-card")).toHaveCount(12);
});
test("sorts all results before pagination; combines filters and recovers from empty search", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "전체 콘텐츠 보기", exact: true })
    .click();
  const titles = page.locator(".project-card h3");
  await expect(titles.first()).toHaveText("도쿄 산책 18");
  await page.getByRole("button", { name: "콘텐츠 더 보기 (6개)" }).click();
  await expect(titles).toHaveCount(18);
  await page.getByLabel("정렬", { exact: true }).selectOption("oldest");
  await expect(titles).toHaveCount(12);
  await expect(titles.first()).toHaveText("서울 카페 01");
  await page.getByRole("searchbox", { name: "콘텐츠 검색" }).fill("도쿄");
  await page.getByLabel("진행 필터").selectOption("review");
  await page.getByLabel("날짜 종류").selectOption("capture");
  await expect(titles).toHaveText([
    "도쿄 산책 02",
    "도쿄 산책 08",
    "도쿄 산책 14",
  ]);
  await page.getByRole("searchbox").fill("없는 콘텐츠");
  await expect(
    page.getByRole("heading", { name: "조건에 맞는 콘텐츠가 없어요." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "전체 콘텐츠 다시 보기" }).click();
  await expect(titles).toHaveCount(12);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("reels-dashboard-demo-v1")!).projects,
    ),
  ).toEqual(projects);
});
test("summary shortcuts and view preferences persist, with responsive controls and compact list", async ({
  page,
}, info) => {
  await page
    .getByRole("button", { name: "검토 대기 보기", exact: true })
    .click();
  await expect(page.locator(".project-card")).toHaveCount(6);
  await expect(page.getByLabel("진행 필터")).toHaveValue("review");
  await page.getByRole("button", { name: "목록 보기", exact: true }).click();
  await page.getByLabel("정렬", { exact: true }).selectOption("priority");
  await page.reload();
  await expect(page.getByLabel("진행 필터")).toHaveValue("active");
  await expect(
    page.getByRole("button", { name: "목록 보기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".board-list .project-card")).toHaveCount(12);
  await page
    .locator(".content-section")
    .screenshot({ path: info.outputPath("board-list-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".board-controls").scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("board-controls-mobile.png") });
  await page
    .getByRole("button", { name: "전체 콘텐츠 보기", exact: true })
    .click();
  await expect(page.getByLabel("진행 필터")).toHaveValue("all");
});

test("opens on unfinished work even after all content was selected; reset returns to active", async ({
  page,
}) => {
  await expect(page.getByLabel("진행 필터")).toHaveValue("active");
  await expect(page.locator(".stats-grid button").first()).toHaveAccessibleName(
    "진행 중 보기",
  );
  await expect(page.locator(".stats-grid button")).toHaveCount(3);
  await page
    .getByRole("button", { name: "전체 콘텐츠 보기", exact: true })
    .click();
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await expect(page.getByLabel("진행 필터")).toHaveValue("active");
  await page
    .getByRole("button", { name: "전체 콘텐츠 보기", exact: true })
    .click();
  await page.reload();
  await expect(page.getByLabel("진행 필터")).toHaveValue("active");
  await expect(page.locator(".project-card")).toHaveCount(12);
});
