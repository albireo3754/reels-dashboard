import { test, expect } from "@playwright/test";

test("signed follow template edits, previews, persists and exports a PNG without a place", async ({
  page,
}, info) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "영상 편집", exact: true }).click();
  await page
    .getByRole("button", { name: "로컬 영상 열기", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "6번 서명 있는 팔로우 마지막 장",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("마지막 장 안내 문구 (두 줄)")).toHaveValue(
    "여행 전에 알아둘 정보를\n더 보고 싶다면",
  );
  await page
    .getByLabel("팔로우 문구", { exact: true })
    .fill("다음 여행도 함께해요");
  await page.getByLabel("서명 (영문 계정명)").fill("@travel_notes 🌹");
  await page.getByLabel("마지막 장 배경 어둡기 (%)").fill("42");
  await page.getByRole("button", { name: "마지막 장 미리보기 만들기" }).click();
  await expect(
    page.getByRole("img", { name: /표지 .* 합성 미리보기/ }),
  ).toBeVisible();
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
  await expect(page.getByLabel("서명 (영문 계정명)")).toHaveValue(
    "@travel_notes 🌹",
  );
  await expect(page.getByLabel("마지막 장 배경 어둡기 (%)")).toHaveValue("42");
  await page
    .getByRole("region", { name: "편집 템플릿" })
    .screenshot({ path: info.outputPath("follow-template.png") });
  await page.getByRole("button", { name: "마지막 장 PNG 내보내기" }).click();
  await expect(
    page.getByRole("heading", { name: "내보내기 완료", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(600);
});
