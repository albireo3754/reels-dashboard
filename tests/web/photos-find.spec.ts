import { test, expect } from "@playwright/test";

test("find footage by metadata, clear stale results and import the matched video", async ({page}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button",{name:"촬영 보관함",exact:true}).click();
  await page.getByLabel("촬영 날짜",{exact:true}).fill("2026-01-15");
  await page.getByLabel("최소 길이(초)").fill("11");
  await page.getByLabel("최대 길이(초)").fill("17");
  await page.getByRole("button",{name:"촬영본 찾기",exact:true}).click();
  const result = page.getByLabel("촬영본 검색 결과");
  await expect(result).toContainText("15개 중 3개");
  await expect(result.getByRole("button",{name:"프로젝트로 추가"})).toHaveCount(3);
  await page.getByRole("button",{name:"약 2분 (90~150초)"}).click();
  await expect(result).toHaveCount(0);
  await page.getByRole("button",{name:"촬영본 찾기",exact:true}).click();
  await expect(result).toContainText("15개 중 0개");
  await page.getByLabel("최소 길이(초)").fill("11");
  await page.getByLabel("최대 길이(초)").fill("11");
  await page.getByRole("button",{name:"촬영본 찾기",exact:true}).click();
  await expect(result).toContainText("DEMO_004.MOV");
  await page.screenshot({path:"test-results/photos-find.png"});
  await result.getByRole("button",{name:"프로젝트로 추가"}).click();
  await expect(page.getByRole("heading",{name:"Photos 예시 demo-asset-4.mov",exact:true})).toBeVisible();
});
