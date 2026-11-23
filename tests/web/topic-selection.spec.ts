import { test, expect, type Page } from "@playwright/test";

/**
 * "소재 선정" on the Dashboard tab: pitches that cross a proven hook with our footage, beside the work queue.
 * Synthetic localStorage data only (web demo bridge).
 */
const at = "2026-11-16T00:00:00+09:00";
const pitch = (id: string, title: string, readiness: string, extra: Record<string, unknown> = {}) => ({
  id, channel: "instagram", title, hookFamily: "현지인·간접체험", coverHooks: ["단골들이 먼저 말 걸어주는 / 바닷가 로컬 이자카야"],
  basedOn: [{ title: "예전 히트 릴스", evidence: "저장 1.9% · 공유 2.5%" }], source: "완성본 25초", effort: "S", readiness,
  asks: [], decision: "proposed", updatedAt: at, ...extra,
});
const project = (id: string, title: string, stage: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, date: "2026-11-01", nextAction: "다음 행동", stage, publicURL: "", shared: false, ...extra });
const projects = [
  project("tax", "면세 아이디어", "idea", { sourceBoard: {
    title: "촬영 소스 보드", basis: "현장에서 확인한 촬영 순서", updatedAt: at, units: [],
  }, pitches: [pitch("d2", "면세 변경 정보", "needs_edit", { rank: 2, coverHooks: ["11월부터 바뀐 / 면세 받는 법", "쇼핑 가기 전에 / 바뀐 면세 순서"], captionHead: "11월부터 면세 순서가 달라졌어요", hypothesis: "지금 알릴 이유가 공유를 올릴까" })] }),
  project("izakaya", "이자카야 영상", "review", { pitches: [pitch("d1", "단골 간접체험", "ready", { rank: 1 })] }),
  project("smoothie", "스무디 촬영분", "editing", { pitches: [pitch("d4", "편의점 스무디", "needs_user", { rank: 4, asks: ["직접 마셔 본 맛 감상 한 줄"] }), pitch("d9", "버린 후보", "hold", { decision: "dropped" })] }),
];
const planning = { schemaVersion: 1, updatedAt: "2026-11-16T00:00:00.000Z", weeklyTarget: 3, calendar: null, linear: null };

async function seed(page: Page) {
  await page.clock.install({ time: new Date("2026-11-16T01:00:00Z") });
  await page.addInitScript(({ planning, projects }) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("reels-planning-demo-v1", JSON.stringify(planning));
    localStorage.setItem("reels-dashboard-demo-v1", JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-16T00:00:00.000Z", projects }));
  }, { planning, projects });
  await page.goto("/?demo=1");
}

test("topic selection: pitches in readiness order with the gap they fill, details on demand, pick and drop persist", async ({ page }, info) => {
  await seed(page);
  const panel = page.getByTestId("topic-selection");
  await expect(panel.getByRole("heading", { name: "소재 선정" })).toBeVisible();
  await expect(panel.getByText(/이번 주 릴스 2편 남음 .*후보 3 \(바로 1 · 편집 1 · 내 답 1\)/)).toBeVisible();
  const rows = panel.getByRole("listitem").filter({ has: page.locator(".topic-title") });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("단골 간접체험");
  await expect(rows.nth(0)).toContainText("바로 올릴 수 있음");
  await expect(rows.nth(1)).toContainText("면세 변경 정보");
  await expect(rows.nth(2).locator(".topic-asks")).toHaveText("직접 마셔 본 맛 감상 한 줄");
  await expect(panel.getByText("버린 후보")).toHaveCount(0);
  await expect(panel.getByText("제외한 후보 1개")).toBeVisible();
  // The recommended cover hook shows as two lines; the rest waits behind 근거.
  await expect(rows.nth(1).getByLabel("표지 훅: 11월부터 바뀐 면세 받는 법")).toBeVisible();
  await expect(rows.nth(1).getByText("쇼핑 가기 전에")).toBeHidden();
  await rows.nth(1).locator("summary").click();
  await expect(rows.nth(1).getByText("쇼핑 가기 전에")).toBeVisible();
  await expect(rows.nth(1).getByText("예전 히트 릴스")).toBeVisible();
  await expect(rows.nth(1).getByText("지금 알릴 이유가 공유를 올릴까")).toBeVisible();
  for (const width of [1500, 760, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.screenshot({ path: info.outputPath(`topic-selection-${width}.png`) });
    const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1500, height: 1000 });

  await rows.nth(1).getByRole("button", { name: "면세 아이디어" }).click();
  const dialog = page.getByRole("dialog", { name: "콘텐츠 기록" });
  const sourceBoard = dialog.getByRole("region", { name: "소스 보드" });
  await expect(sourceBoard.getByRole("heading", { name: "촬영 소스 보드" })).toBeVisible();
  await expect(sourceBoard.getByText("등록된 소재가 없어요.")).toBeVisible();
  await dialog.getByRole("button", { name: "콘텐츠 기록 닫기" }).click();

  // Picking moves it to the top and is saved; dropping removes it from the board.
  await rows.nth(2).getByRole("button", { name: "선정", exact: true }).click();
  await expect(rows.nth(0)).toContainText("편의점 스무디");
  await expect(rows.nth(0)).toContainText("선정");
  await expect(panel.getByText(/후보 3 \(선정 1 · 바로 1 · 편집 1\)/)).toBeVisible();
  await rows.filter({ hasText: "면세 변경 정보" }).getByRole("button", { name: "제외" }).click();
  await expect(rows).toHaveCount(2);
  await expect(panel.getByText("제외한 후보 2개")).toBeVisible();
  await page.reload();
  await expect(rows.nth(0)).toContainText("편의점 스무디");
  await expect(rows).toHaveCount(2);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("reels-dashboard-demo-v1") ?? "{}"));
  const decisions = stored.projects.flatMap((p: { pitches?: { id: string; decision: string }[] }) => (p.pitches ?? []).map((x) => `${x.id}:${x.decision}`));
  expect(decisions.sort()).toEqual(["d1:proposed", "d2:dropped", "d4:picked", "d9:dropped"]);
});

test("topic selection: the gap line follows a weekly goal edited right above it", async ({ page }) => {
  await seed(page);
  const panel = page.getByTestId("topic-selection");
  await expect(panel.getByText(/이번 주 릴스 2편 남음/)).toBeVisible();
  const goals = page.getByTestId("weekly-goals");
  await goals.getByRole("button", { name: "목표 수정" }).click();
  const form = goals.getByRole("form", { name: "주간 목표 수정" });
  await form.getByLabel("릴스").fill("3");
  await form.getByRole("button", { name: "저장" }).click();
  await expect(panel.getByText(/이번 주 릴스 3편 남음/)).toBeVisible();
});
