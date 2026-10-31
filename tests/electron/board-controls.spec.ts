import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

test("packaged board filters and remembers the view without changing stored content", async ({}, info) => {
  const profile = await makeProfile();
  const data = JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-10-28T12:00:00Z",
    projects: [
      {
        id: "published",
        title: "합성 게시 완료",
        date: "2026-10-31",
        stage: "published",
        nextAction: "",
        publicURL: "",
        shared: false,
      },
      {
        id: "old",
        title: "합성 촬영 기록",
        date: "2026-09-01",
        dateBasis: "capture",
        stage: "captured",
        nextAction: "장면 선택",
        publicURL: "",
        shared: false,
      },
      {
        id: "recent",
        title: "합성 영상 검토",
        date: "2026-10-28",
        dateBasis: "record",
        stage: "review",
        nextAction: "표지 확인",
        publicURL: "",
        shared: false,
      },
    ],
  });
  const file = path.join(profile, "dashboard.json");
  await writeFile(file, data);
  let app = await launchApp(profile, false);
  try {
    let page = await app.firstWindow();
    await expect(page.locator(".project-card h3").first()).toHaveText(
      "합성 영상 검토",
    );
    await expect(
      page.getByRole("searchbox", { name: "콘텐츠 검색" }),
    ).toBeInViewport();
    await expect(page.locator(".project-card").first()).toBeInViewport();
    await page
      .getByRole("button", { name: "검토 대기 보기", exact: true })
      .click();
    await page.getByRole("button", { name: "목록 보기", exact: true }).click();
    await expect(page.locator(".project-card")).toHaveCount(1);
    await page
      .locator(".content-section")
      .screenshot({ path: info.outputPath("packaged-board-controls.png") });
    await closeApp(app);
    app = await launchApp(profile, false);
    page = await app.firstWindow();
    await expect(page.getByLabel("진행 필터", { exact: true })).toHaveValue(
      "active",
    );
    await expect(page.locator(".board-list .project-card")).toHaveCount(2);
    expect(await readFile(file, "utf8")).toBe(data);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
