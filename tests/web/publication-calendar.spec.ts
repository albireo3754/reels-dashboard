import { test, expect } from "@playwright/test";
test("calendar separates weekly goals and links to source tools without building a task editor", async ({ page }, info) => {
  await page.clock.install({ time: new Date("2026-11-12T08:00:00Z") });
  await page.addInitScript(() => {
    localStorage.setItem("reels-planning-demo-v1", JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-12T08:00:00Z", weeklyTarget: 3,
      calendar: { url: "https://calendar.google.com/calendar/u/0/r/week", syncedAt: "2026-11-12T08:00:00Z", window: { from: "2026-11-09", to: "2026-11-23" }, events: [{ id: "sample-event", title: "샘플 공개 일정", projectId: "scheduled", channel: "naver-clip", cancelled: false, start: "2026-11-20T15:56:00+09:00", url: "https://calendar.google.com/calendar/event?eid=sample" }] },
      linear: { url: "https://linear.app/example/team/CONTENT/all", syncedAt: "2026-11-12T08:00:00Z", window: { from: "2026-11-09", to: "2026-11-23" }, issues: [{ id: "sample-issue", identifier: "CONTENT-1", title: "다음 콘텐츠 선정", url: "https://linear.app/example/issue/CONTENT-1", dueDate: "2026-11-20", state: "unstarted" }] } }));
  });
  await page.goto("/?demo=1");
  await page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("button", { name: "캘린더", exact: true }).click();
  const next = page.getByRole("article", { name: "다음 주", exact: true });
  await expect(next.getByText("1 / 3", { exact: true })).toBeVisible();
  await expect(next.getByText("게시 0 · 예정 1 · 남은 2개")).toBeVisible();
  await expect(next.getByRole("link", { name: /샘플 공개 일정/ })).toHaveAttribute("href", /calendar.google.com/);
  await expect(next.getByRole("link", { name: /CONTENT-1/ })).toHaveAttribute("href", /linear.app/);
  await expect(page.getByText(/실시간 자동 동기화는 하지 않아요/)).toBeVisible();
  await page.getByRole("button", { name: "다음 주", exact: true }).click();
  await expect(page.getByText(/이 주 전체의 Google Calendar 조회 결과가 없어요/)).toBeVisible();
  await page.getByRole("button", { name: "이번 주", exact: true }).click();
  for (const width of [1500, 760, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`calendar-${width}.png`), fullPage: true });
  }
});
