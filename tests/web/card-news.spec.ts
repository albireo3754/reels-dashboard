import { test, expect } from "@playwright/test";
test("card planner recomputes timing, reorders, previews and fits mobile", async ({
  page,
}, info) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "카드뉴스 릴스", exact: true })
    .click();
  await expect(page.getByTestId("card-total")).toHaveText("24.00초 · 6장");
  await page
    .getByLabel("1번 문구", { exact: true })
    .fill("여행 전에\n꼭 확인할 정보예요");
  await page.getByLabel("1번 노출 시간", { exact: true }).fill("1");
  await expect(page.getByTestId("card-total")).toHaveText("22.00초 · 6장");
  await page
    .getByRole("button", { name: "읽는 시간 추천 적용", exact: true })
    .click();
  await expect(page.getByLabel("1번 노출 시간", { exact: true })).toHaveValue(
    "3",
  );
  await page.getByRole("button", { name: "1번 아래로", exact: true }).click();
  await expect(page.getByLabel("2번 문구", { exact: true })).toHaveValue(
    "여행 전에\n꼭 확인할 정보예요",
  );
  await page
    .getByRole("button", { name: "카드 미리보기 만들기", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "2번 카드 미리보기", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "처음부터 재생", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "재생 멈춤", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "대시보드", exact: true }).click();
  await page
    .getByRole("button", { name: "카드뉴스 릴스", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "처음부터 재생", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("card-news-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("card-news-desktop.png") });
  await expect(
    page.getByRole("button", { name: "MP4 내보내기", exact: true }),
  ).toBeDisabled();
});

test("template contract rejects custom styles and removes editing escape hatches", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "카드뉴스 릴스", exact: true })
    .click();
  await expect(page.getByLabel("글자 크기 (px)", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: /오버레이 선택/ })).toHaveCount(
    0,
  );
  await page.getByLabel("1번 크게 강조", { exact: true }).check();
  await page
    .getByLabel("1번 문구", { exact: true })
    .fill("첫 번째 문장\n두 번째 문장");
  await page
    .getByRole("button", { name: "카드 미리보기 만들기", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "1번 카드 미리보기", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const contract = "/src/shared/card-news.ts";
    const model = "/src/shared/card-news-model.ts";
    const { cardPlanSchema, templateContent } = await import(contract);
    const { newCardPlan } = await import(model);
    const plan = newCardPlan();
    let perLine = false,
      overlay = false,
      size = false;
    try {
      cardPlanSchema.parse({
        ...plan,
        cards: [{ ...plan.cards[0], fontSize: 70 }],
      });
    } catch {
      perLine = true;
    }
    try {
      templateContent({ ...plan.cards[0], overlayId: crypto.randomUUID() });
    } catch {
      overlay = true;
    }
    try {
      cardPlanSchema.parse({ ...plan, style: { ...plan.style, fontSize: 90 } });
    } catch {
      size = true;
    }
    return { perLine, overlay, size };
  });
  expect(result).toEqual({ perLine: true, overlay: true, size: true });
});

test("only three card kinds are exposed and changes retain content and timing", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "카드뉴스 릴스", exact: true })
    .click();
  const kind = page.getByLabel("2번 카드 종류", { exact: true });
  await expect(kind.locator("option")).toHaveText(["문구", "비교표", "마무리"]);
  await expect(page.getByLabel("2번 역할", { exact: true })).toHaveCount(0);
  await page.getByLabel("2번 문구", { exact: true }).fill("확인할 내용");
  await page.getByLabel("2번 노출 시간", { exact: true }).fill("2");
  await kind.selectOption("comparison");
  await expect(page.getByText("2번 표 머리글", { exact: true })).toBeVisible();
  await kind.selectOption("follow");
  await expect(page.getByText("2번 서명", { exact: true })).toBeVisible();
  await kind.selectOption("text");
  await page.getByLabel("2번 크게 강조", { exact: true }).check();
  await expect(page.getByLabel("2번 문구", { exact: true })).toHaveValue(
    "확인할 내용",
  );
  await expect(page.getByLabel("2번 노출 시간", { exact: true })).toHaveValue(
    "2",
  );
});
