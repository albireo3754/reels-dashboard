import { test, expect, type Page } from "@playwright/test";
async function open(page: Page) {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await page
    .getByRole("button", { name: "로컬 영상 열기", exact: true })
    .click();
  await page.getByText("템플릿 세부 조정", { exact: true }).click();
  await page.getByLabel("장소명", { exact: true }).fill("서울");
  await page.getByLabel("장소 설명", { exact: true }).fill("함께 걷는 길");
  await page
    .getByLabel("표지 훅", { exact: true })
    .fill("함께 걷는\n가을 산책");
}
test("templates, independent adjustments and fixed size persist without replacing content", async ({
  page,
}, info) => {
  await open(page);
  await page.getByLabel("표지 시점", { exact: true }).fill("3");
  await page
    .getByRole("button", { name: "영상 미리보기 만들기", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: /영상 .* 합성 미리보기/ }),
  ).toBeVisible();
  for (const [name, material] of [
    ["1번 장소 핀만", "none"],
    ["3번 핀 + 설명 사각 바", "rectangle"],
    ["2번 핀 + 설명 테이프", "tape"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("combobox", { name: "설명 재질", exact: true }),
    ).toHaveValue(material);
  }
  await expect(
    page.getByRole("img", { name: /영상 .* 합성 미리보기/ }),
  ).toHaveCount(0);
  await page
    .getByLabel("영상 장소 묶음 세로 이동 (%)", { exact: true })
    .fill("2");
  await page
    .getByLabel("표지 훅 묶음 세로 이동 (%)", { exact: true })
    .fill("-2");
  await page
    .getByLabel("표지 장소 핀 가로 이동 (%)", { exact: true })
    .fill("1");
  await page.getByLabel("표지 글자 크기 직접 지정", { exact: true }).check();
  await page.getByLabel("표지 글자 크기 (px)", { exact: true }).fill("145");
  await page
    .getByRole("button", { name: "5번 표지 185px 고정", exact: true })
    .click();
  await expect(
    page.getByLabel("표지 글자 크기 직접 지정", { exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "4번 표지 자동 크기", exact: true })
    .click();
  await expect(page.getByLabel("표지 시점", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("장소 설명", { exact: true })).toHaveValue(
    "함께 걷는 길",
  );
  await page.getByLabel("표지 글자 크기 직접 지정", { exact: true }).check();
  await page.getByLabel("표지 글자 크기 (px)", { exact: true }).fill("165");
  await page
    .getByRole("button", { name: "편집 설정 저장", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await page
    .getByRole("button", {
      name: "편집 기록 열기 예시 산책 영상.mp4",
      exact: true,
    })
    .click();
  await page.getByText("템플릿 세부 조정", { exact: true }).click();
  await expect(
    page.getByLabel("영상 장소 묶음 세로 이동 (%)", { exact: true }),
  ).toHaveValue("2");
  await expect(
    page.getByLabel("표지 훅 묶음 세로 이동 (%)", { exact: true }),
  ).toHaveValue("-2");
  await expect(
    page.getByLabel("표지 장소 핀 가로 이동 (%)", { exact: true }),
  ).toHaveValue("1");
  await expect(
    page.getByLabel("표지 글자 크기 (px)", { exact: true }),
  ).toHaveValue("165");
  await expect(
    page.getByLabel("장소 안내 기본 배치 사용", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByLabel("표지 기본 배치 사용", { exact: true }),
  ).toBeChecked();
  await page
    .getByRole("region", { name: "편집 템플릿" })
    .screenshot({ path: info.outputPath("template-panel.png") });
});
test("template controls lock during rendering and fit narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await open(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(600);
  await page
    .getByRole("button", { name: "영상과 표지 내보내기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "1번 장소 핀만", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("영상 장소 묶음 가로 이동 (%)", { exact: true }),
  ).toBeDisabled();
});
