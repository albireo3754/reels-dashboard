import { expect, test } from "@playwright/test";

const base = { date: "2026-11-01", nextAction: "", publicURL: "", shared: false };
const projects = [
  {
    ...base,
    id: "both",
    title: "두 채널 게시",
    stage: "published",
    publications: [
      { channel: "instagram", status: "published", url: "https://example.com/reel", publishedAt: "2026-11-01" },
      { channel: "naver-clip", status: "published", url: "" },
    ],
  },
  {
    ...base,
    id: "clip-only",
    title: "클립만 게시",
    stage: "review",
    publications: [
      { channel: "instagram", status: "planned", url: "" },
      { channel: "naver-clip", status: "published", url: "https://example.com/clip", publishedAt: "2026-11-06" },
    ],
  },
  { ...base, id: "plain", title: "채널 없음", stage: "editing" },
];
test.beforeEach(async ({ page }) => {
  await page.addInitScript((projects) => {
    if (!localStorage.getItem("reels-dashboard-demo-v1"))
      localStorage.setItem(
        "reels-dashboard-demo-v1",
        JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-12T00:00:00Z", projects }),
      );
  }, projects);
  await page.goto("/?demo=1");
  await expect(page.locator(".project-card")).toHaveCount(2);
});

test("cards show each channel and the channel filter judges progress per channel", async ({ page }) => {
  const titles = page.locator(".project-card h3");
  const clipOnly = page.locator(".project-card", { hasText: "클립만 게시" });
  await expect(clipOnly.locator(".project-channels li")).toHaveText([
    "인스타그램 · 예정",
    "네이버클립 · 2026-11-06 게시 ↗",
  ]);
  await expect(clipOnly.getByRole("link", { name: /네이버클립/ })).toHaveAttribute("href", "https://example.com/clip");

  const channel = page.getByLabel("채널 필터", { exact: true });
  const stage = page.getByLabel("진행 필터", { exact: true });
  await channel.selectOption("naver-clip");
  await expect(titles).toHaveCount(0);
  await stage.selectOption("published");
  await expect(titles).toHaveText(["두 채널 게시", "클립만 게시"]);
  await channel.selectOption("instagram");
  await expect(titles).toHaveText(["두 채널 게시"]);
  await stage.selectOption("active");
  await expect(titles).toHaveText(["클립만 게시"]);
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await expect(channel).toHaveValue("all");
  await expect(titles).toHaveCount(2);
});

test("the content form edits one channel and saves it", async ({ page }) => {
  const card = page.locator(".project-card", { hasText: "채널 없음" });
  await card.getByRole("button", { name: "채널 없음 수정" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("블로그 게시 링크")).toBeDisabled();
  await dialog.getByLabel("블로그 게시 상태").selectOption("published");
  await dialog.getByLabel("블로그 게시 링크").fill("https://example.com/post");
  await dialog.getByLabel("블로그 게시일").fill("2026-11-10");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(card.locator(".project-channels li")).toHaveText(["블로그 · 2026-11-10 게시 ↗"]);
  await page.screenshot({ path: "test-results/publications-board.png", fullPage: true });
});
