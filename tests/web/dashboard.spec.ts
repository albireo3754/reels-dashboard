import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function openDemo(page: Page) {
  await page.goto("/?demo=1");
  await expect(
    page.getByRole("heading", { name: "작업의 흐름을 한눈에", exact: true }),
  ).toBeVisible();
}

test("content stage and next action survive a browser reload", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("button", { name: "새 콘텐츠", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "콘텐츠 기록" });
  await expect(dialog.getByLabel("콘텐츠 제목", { exact: true })).toBeFocused();
  await dialog
    .getByLabel("콘텐츠 제목", { exact: true })
    .fill("Persistent synthetic project");
  await dialog.getByLabel("콘텐츠 날짜", { exact: true }).fill("2026-10-27");
  await dialog
    .getByRole("combobox", { name: "진행 단계", exact: true })
    .selectOption("review");
  await dialog
    .getByLabel("다음 할 일", { exact: true })
    .fill("Check the opening caption");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  const card = page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Persistent synthetic project",
        exact: true,
      }),
    });
  await expect(card).toContainText("검토 대기");
  await expect(card).toContainText("Check the opening caption");
  await card
    .getByRole("button", { name: "Persistent synthetic project 수정" })
    .click();
  await expect(
    page.getByRole("combobox", { name: "진행 단계", exact: true }),
  ).toHaveValue("review");
});

test("snapshot download includes only explicitly selected projects and public fields", async ({
  page,
}) => {
  await openDemo(page);
  await page
    .getByRole("button", { name: "도쿄의 오후 산책 수정", exact: true })
    .click();
  await page.getByLabel("모바일에 공유", { exact: true }).uncheck();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByRole("button", { name: "새 콘텐츠", exact: true }).click();
  await page
    .getByLabel("콘텐츠 제목", { exact: true })
    .fill("Only this shared fixture");
  await page
    .getByRole("combobox", { name: "진행 단계", exact: true })
    .selectOption("editing");
  await page.getByLabel("모바일에 공유", { exact: true }).check();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByText("공유 항목 1개", { exact: true })).toBeVisible();
  const pendingDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "공유 현황 내보내기", exact: true })
    .click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe("snapshot.json");
  const path = await download.path();
  expect(path).not.toBeNull();
  const snapshot = JSON.parse(await readFile(path!, "utf8"));
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.projects).toHaveLength(1);
  expect(snapshot.projects[0].title).toBe("Only this shared fixture");
  expect(Object.keys(snapshot.projects[0]).sort()).toEqual([
    "date",
    "id",
    "nextAction",
    "publicURL",
    "stage",
    "title",
  ]);
  expect(Number.isFinite(Date.parse(snapshot.generatedAt))).toBe(true);
});

test("invalid public link is rejected without persisting a project", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("button", { name: "새 콘텐츠", exact: true }).click();
  await page
    .getByLabel("콘텐츠 제목", { exact: true })
    .fill("Invalid link fixture");
  await page
    .getByLabel("게시 링크", { exact: true })
    .fill("javascript:alert(1)");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTPS");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Invalid link fixture", exact: true }),
  ).toHaveCount(0);
});

test("demo sync rejects HTTP and clears the token after successful synthetic sync", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByLabel("동기화 주소", { exact: true })
    .fill("http://example.com/api/snapshot");
  await page
    .getByRole("button", { name: "선택한 현황 동기화", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("HTTPS");
  await page
    .getByLabel("동기화 주소", { exact: true })
    .fill("https://example.com/api/snapshot");
  await page
    .getByLabel("인증 토큰", { exact: true })
    .fill("synthetic-test-token");
  await page
    .getByRole("button", { name: "선택한 현황 동기화", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("1개 콘텐츠");
  await expect(page.getByLabel("인증 토큰", { exact: true })).toHaveValue("");
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain("synthetic-test-token");
});
