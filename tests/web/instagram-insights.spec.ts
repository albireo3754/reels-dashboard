import { test, expect } from "@playwright/test";
import { fixtureInsightsState } from "../fixtures/instagram-insights";
test("private Instagram view compares cohorts, labels topics and stays readable", async ({
  page,
}, info) => {
  await page.addInitScript(
    (state) =>
      localStorage.setItem("reels-instagram-demo-v1", JSON.stringify(state)),
    fixtureInsightsState(),
  );
  await page.goto("/?demo=1");
  await page
    .getByRole("navigation", { name: "주요 메뉴" })
    .getByRole("button", { name: "Instagram 인사이트", exact: true })
    .click();
  const feature = page.getByRole("region", { name: "Instagram 인사이트" });
  await expect(
    feature.getByText("15.00%", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    feature.getByText("합성 데모 데이터예요.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("제외 시작일").fill("2026-09-24");
  await page.getByLabel("제외 종료일").fill("2026-09-27");
  await expect(
    feature.getByText("10.00%", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    feature.getByText("기간 제외 전 2개 · 캐러셀은 비교 제외"),
  ).toBeVisible();
  await page.getByLabel("103 주제").fill("음식");
  await page.getByLabel("103 주제").blur();
  await expect(
    page
      .getByRole("figure", { name: "주제별 반응률" })
      .getByText("음식", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "조회 토큰 파일 연결" }),
  ).toBeHidden();
  for (const width of [1500, 760, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`instagram-${width}.png`),
      fullPage: true,
    });
  }
});
test("unconnected view never invents account metrics", async ({ page }) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("navigation", { name: "주요 메뉴" })
    .getByRole("button", { name: "Instagram 인사이트", exact: true })
    .click();
  await expect(page.getByText("아직 수집한 지표가 없어요")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Instagram에서 가져오기" }),
  ).toBeDisabled();
});

test("scheduled source and an approaching known token expiry are visible", async ({ page }) => {
  const state = fixtureInsightsState();
  state.snapshot!.source = "scheduled";
  state.history[0]!.source = "scheduled";
  state.connection!.tokenHealth = { status: "expiring", expiresAt: "2026-11-15T00:00:00Z" };
  await page.addInitScript(state => localStorage.setItem("reels-instagram-demo-v1", JSON.stringify(state)), state);
  await page.goto("/?demo=1");
  await page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("button", { name: "Instagram 인사이트", exact: true }).click();
  await expect(page.getByText(/토큰 만료 임박/)).toBeVisible();
  await expect(page.getByText(/에 수집 · KST · 예약/)).toBeVisible();
});
