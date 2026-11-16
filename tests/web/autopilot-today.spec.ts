import { test, expect, type Page } from "@playwright/test";

/**
 * The "퇴근 후 오늘 볼 1개" card on the Dashboard tab. The web demo bridge computes the same read-only
 * view from its own Linear copy and projects, so these cases only seed synthetic localStorage data.
 */
const window2 = { from: "2026-11-09", to: "2026-11-23" };
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `synthetic-${n}`, identifier: `CONTENT-${n}`, title: `합성 이슈 ${n}`, url: `https://linear.app/example/issue/CONTENT-${n}`,
  dueDate: null, state: "unstarted", ...extra,
});
const linear = (issues: unknown[], syncedAt: string) => ({
  schemaVersion: 1, updatedAt: syncedAt, weeklyTarget: 3, calendar: null,
  linear: { url: "https://linear.app/example/team/CONTENT/all", syncedAt, window: window2, issues },
});
const project = (id: string, stage: string, title: string) => ({ id, title, date: "2026-11-10", nextAction: "다음 행동 메모", stage, publicURL: "", shared: false });

async function seed(page: Page, data: { planning?: unknown; projects?: unknown[]; autopilot?: unknown }) {
  await page.clock.install({ time: new Date("2026-11-16T05:00:00Z") });
  await page.addInitScript(({ planning, projects, autopilot }) => {
    if (planning) localStorage.setItem("reels-planning-demo-v1", JSON.stringify(planning));
    if (projects) localStorage.setItem("reels-dashboard-demo-v1", JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-16T00:00:00.000Z", projects }));
    if (autopilot) localStorage.setItem("reels-autopilot-demo-v1", JSON.stringify(autopilot));
  }, data);
  await page.goto("/?demo=1");
}
async function fitsAt(page: Page, info: { outputPath(name: string): string }, name: string) {
  for (const width of [1500, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const card = page.getByTestId("autopilot-today");
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${width}`).toBe(true);
    const box = await card.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width + 1, `card inside the viewport at ${width}`).toBe(true);
    await page.screenshot({ path: info.outputPath(`autopilot-${name}-${width}.png`), fullPage: true });
  }
}

test("today: one review item with its link, the reason, the one decision and the done criterion", async ({ page }, info) => {
  await seed(page, { planning: linear([issue(2, { state: "triage", priority: 1 }), issue(3, { state: "started", stateName: "In Progress" }), issue(1)], "2026-11-16T04:30:00Z") });
  const card = page.getByTestId("autopilot-today");
  await expect(card.getByRole("heading", { name: "퇴근 후 오늘 볼 1개" })).toBeVisible();
  await expect(card.getByTestId("autopilot-status")).toHaveText("리뷰 대기 1 · 진행 중 3 · 점유 1/3 · 자동 슬롯 2");
  const link = card.getByRole("link", { name: /합성 이슈 2/ });
  await expect(link).toHaveAttribute("href", "https://linear.app/example/issue/CONTENT-2");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(card.getByText("왜 지금", { exact: true })).toBeVisible();
  await expect(card.getByText("필요한 한 가지", { exact: true })).toBeVisible();
  await expect(card.getByText("완료 기준", { exact: true })).toBeVisible();
  await expect(card.getByText("검토 후 승인 또는 수정 요청을 결정")).toBeVisible();
  // Exactly one pick, and nothing blocks automatic runs.
  await expect(card.getByRole("heading", { level: 4 })).toHaveCount(1);
  await expect(card.getByTestId("autopilot-blocked")).toHaveCount(0);
  await fitsAt(page, info, "today");
});

test("today: a Dashboard project opens through the existing project dialog", async ({ page }) => {
  await seed(page, { planning: linear([], "2026-11-16T04:30:00Z"), projects: [project("review-project", "review", "검토 중인 콘텐츠")] });
  const card = page.getByTestId("autopilot-today");
  await expect(card.getByTestId("autopilot-status")).toContainText("리뷰 대기 1");
  await card.getByRole("button", { name: "검토 중인 콘텐츠" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("none: no review item and no unblocked work says so instead of inventing one", async ({ page }, info) => {
  await seed(page, { planning: linear([issue(1), issue(9, { state: "completed" })], "2026-11-16T04:30:00Z"), projects: [] });
  const card = page.getByTestId("autopilot-today");
  await expect(card.getByText("오늘 볼 항목 없음")).toBeVisible();
  await expect(card.getByTestId("autopilot-status")).toHaveText("리뷰 대기 0 · 진행 중 0 · 점유 0/3 · 자동 슬롯 1");
  await expect(card.getByRole("heading", { level: 4 })).toHaveCount(0);
  await fitsAt(page, info, "none");
});

test("stale: an old Linear copy says automatic runs are stopped, with no free slots", async ({ page }, info) => {
  await seed(page, { planning: linear([issue(2, { state: "triage" }), issue(1)], "2026-11-16T00:00:00Z") });
  const card = page.getByTestId("autopilot-today");
  await expect(card.getByTestId("autopilot-blocked")).toHaveText("Linear 사본이 오래됐어요 — 자동 실행 멈춤");
  await expect(card.getByTestId("autopilot-status")).toContainText("자동 슬롯 0");
  // The item to look at is still shown: stopping automation does not hide what the user can do.
  await expect(card.getByRole("link", { name: /합성 이슈 2/ })).toBeVisible();
  await fitsAt(page, info, "stale");
});

test("auth-blocked and paused: the last tick's Linear auth failure and a pause are both visible", async ({ page }, info) => {
  await seed(page, {
    planning: linear([issue(2, { state: "triage" })], "2026-11-15T20:00:00Z"),
    autopilot: {
      lastTick: { at: "2026-11-16T04:50:00.000Z", result: "freshness", reason: "Linear 갱신에 실패해 자동 실행을 시작하지 않았어요: linear_auth_missing" },
      paused: { at: "2026-11-16T04:00:00.000Z", reason: "manual" },
    },
  });
  const card = page.getByTestId("autopilot-today");
  await expect(card.getByTestId("autopilot-blocked")).toHaveText("Linear 인증 필요 — 자동 실행 멈춤");
  await expect(card.getByTestId("autopilot-paused")).toContainText("일시정지");
  await fitsAt(page, info, "auth");
});
