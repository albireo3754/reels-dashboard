import { test, expect, type Page } from "@playwright/test";

/**
 * "이번 주 목표" on the Dashboard tab: per-channel weekly goals, what fills them, and the two-week posting
 * queue ("게시 대기열", blog and video). Synthetic localStorage data only (web demo bridge).
 */
const project = (id: string, title: string, stage: string, publications: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, title, date: "2026-11-01", nextAction: "다음 행동", stage, publicURL: "", shared: false, publications, ...extra });
const projects = [
  project("blog-live", "블로그 게시 완료 글", "published", [{ channel: "blog", status: "published", url: "", publishedAt: "2026-11-17" }]),
  project("blog-draft", "블로그 임시저장 글", "published", [{ channel: "blog", status: "draft", url: "" }], { priority: 1 }),
  project("clip-booked", "클립 예약 영상", "published", [{ channel: "instagram", status: "published", url: "", publishedAt: "2026-10-01" }, { channel: "naver-clip", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }]),
  project("reel-old", "재업할 지난 릴스", "published", [{ channel: "instagram", status: "published", url: "", publishedAt: "2026-11-02" }]),
  project("reel-ready", "완성된 새 릴스", "editing", [{ channel: "instagram", status: "planned", url: "" }], { resources: [{ role: "final", path: "/tmp/reel-ready.mp4", label: "완성본" }] }),
  project("reel-review", "검토 대기 릴스", "review", [{ channel: "instagram", status: "planned", url: "" }], { resources: [{ role: "final", path: "/tmp/reel-review.mp4", label: "완성본" }] }),
  project("reel-draft", "채널 임시저장 릴스", "editing", [{ channel: "instagram", status: "draft", url: "" }]),
  project("reel-wip", "편집 중인 릴스", "editing", [{ channel: "instagram", status: "planned", url: "" }]),
  project("short-ready", "완성된 쇼츠", "review", [{ channel: "youtube", status: "planned", url: "" }]),
];
const planning = { schemaVersion: 1, updatedAt: "2026-11-16T00:00:00.000Z", weeklyTarget: 3, calendar: null, linear: null };

async function seed(page: Page) {
  await page.clock.install({ time: new Date("2026-11-16T01:00:00Z") });
  await page.addInitScript(({ planning, projects }) => {
    localStorage.setItem("reels-planning-demo-v1", JSON.stringify(planning));
    localStorage.setItem("reels-dashboard-demo-v1", JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-16T00:00:00.000Z", projects }));
  }, { planning, projects });
  await page.goto("/?demo=1");
}

test("weekly goals: four channels with progress, what fills each, and the two-week posting queue", async ({ page }, info) => {
  await seed(page);
  const panel = page.getByTestId("weekly-goals");
  await expect(panel.getByRole("heading", { name: "이번 주 목표" })).toBeVisible();
  await expect(panel.getByText("8개 중 2개 · 남은 6개")).toBeVisible();

  const blog = panel.getByRole("article", { name: "블로그 이번 주" });
  await expect(blog.getByText("게시 1 · 이번 주 예약 0 · 남은 1")).toBeVisible();
  // Which posts make up the count, not just the numbers.
  await expect(blog.getByRole("list", { name: "블로그 이번 주 게시·예약" }).getByRole("listitem")).toHaveText([/11\. 17\..*블로그 게시 완료 글.*게시/]);
  await expect(blog.getByRole("list", { name: "블로그 채울 것" }).getByRole("listitem")).toHaveText([/블로그 임시저장 글.*임시저장/]);
  const clip = panel.getByRole("article", { name: "클립 이번 주" });
  await expect(clip.getByText("게시 0 · 이번 주 예약 1 · 남은 2")).toBeVisible();
  await expect(clip.getByRole("list", { name: "클립 이번 주 게시·예약" }).getByRole("listitem")).toHaveText([/11\. 20\..*클립 예약 영상.*예약/]);
  await expect(clip.getByRole("list", { name: "클립 채울 것" }).getByRole("listitem").first()).toContainText("재업 후보");
  // Reels: 2 a week, none live yet, so the first two candidates in work order show (review comes before editing).
  await expect(panel.getByRole("article", { name: "릴스 이번 주" }).getByRole("list", { name: "릴스 채울 것" }).getByRole("listitem")).toHaveText([/검토 대기 릴스.*검토 대기/, /완성된 새 릴스.*완성본/]);

  const queue = panel.getByRole("region", { name: "게시 대기열" });
  await expect(queue.getByText(/오늘부터 2주 · 11\. 29\. \(일\)까지/)).toBeVisible();
  // The blog is queued like the videos: its channel draft is proposed for a day.
  const blogQueue = queue.getByRole("article", { name: "블로그 예약" });
  await expect(blogQueue.getByText("앞으로 예약 0 / 4")).toBeVisible();
  await expect(blogQueue.getByRole("listitem").filter({ hasText: "예약 제안" })).toHaveText([/블로그 임시저장 글.*임시저장/]);
  const clipQueue = queue.getByRole("article", { name: "클립 예약" });
  await expect(clipQueue.getByText("앞으로 예약 1 / 6")).toBeVisible();
  await expect(clipQueue.getByRole("listitem").filter({ hasText: "예약됨" })).toContainText("클립 예약 영상");
  await expect(clipQueue.getByRole("listitem").filter({ hasText: "예약 제안" }).first()).toContainText("재업할 지난 릴스");
  const reels = queue.getByRole("article", { name: "릴스 예약" });
  await expect(reels.getByText("4개 더 예약 가능")).toBeVisible();
  // Only reviewed work is proposed, and each slot says whether it is already on the channel.
  await expect(reels.getByRole("listitem").filter({ hasText: "예약 제안" })).toHaveText([/완성된 새 릴스.*완성본/, /채널 임시저장 릴스.*임시저장/]);
  await expect(reels.getByText("나머지 2칸은 새 완성본이 생기면 채워져요")).toBeVisible();
  // Work still being made is named, not just counted.
  const making = reels.getByLabel("릴스 제작 중");
  await expect(making).toContainText("제작 중 1");
  await expect(making).toContainText("편집 중인 릴스");
  const review = reels.getByLabel("릴스 검토 대기");
  await expect(review).toContainText("검토 대기 1");
  await expect(review).toContainText("검토 대기 릴스");
  await expect(reels.getByRole("listitem").filter({ hasText: "검토 대기 릴스" })).toHaveCount(0);

  // The queue rule lives in a help popover, not a standing paragraph.
  await queue.getByRole("button", { name: "게시 대기열 안내" }).click();
  await expect(page.getByRole("dialog", { name: "게시 대기열 안내" })).toContainText("2주치");
  await page.keyboard.press("Escape");

  // Clicking a project opens it.
  await blog.getByRole("button", { name: "블로그 임시저장 글" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  for (const width of [1500, 760, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${width}`).toBe(true);
    await panel.screenshot({ path: info.outputPath(`weekly-goals-${width}.png`) });
  }
});

test("weekly goals: editing one channel's target saves it and the tiles follow", async ({ page }) => {
  await seed(page);
  const panel = page.getByTestId("weekly-goals");
  await panel.getByRole("button", { name: "목표 수정" }).click();
  const form = panel.getByRole("form", { name: "주간 목표 수정" });
  await form.getByLabel("쇼츠").fill("2");
  await expect(form.getByText("2주 예약 4개까지")).toHaveCount(3); // blog (2), reels (2) and now shorts (2)
  await form.getByRole("button", { name: "저장" }).click();
  await expect(form).toHaveCount(0);
  await expect(panel.getByRole("article", { name: "쇼츠 이번 주" }).getByText("게시 0 · 이번 주 예약 0 · 남은 2")).toBeVisible();
  await expect(panel.getByRole("article", { name: "쇼츠 예약" }).getByText("앞으로 예약 0 / 4")).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("reels-planning-demo-v1") ?? "{}"));
  expect(saved.weeklyTargets).toEqual({ blog: 2, "naver-clip": 3, instagram: 2, youtube: 2 });
});
