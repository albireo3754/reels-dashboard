import { test, expect } from "@playwright/test";
import { writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
test("UI merges cards, preserves files and backup, and restores one project after restart", async () => {
  const profile = await makeProfile();
  let app;
  try {
    const resource = { role: "draft", path: path.join(profile, "v1.mp4"), label: "첫 출력" };
    await writeFile(resource.path, "unchanged");
    const projects = ["대표 콘텐츠", "이전 버전"].map((title, i) => ({
      id: i ? "old-version" : "parent", title, date: "2026-10-31", stage: "review",
      nextAction: "", publicURL: "", shared: false, resources: i ? [resource] : [],
    }));
    await writeFile(path.join(profile, "dashboard.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-10-31T00:00:00.000Z", projects }));
    app = await launchApp(profile, false);
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "이전 버전 수정", exact: true }).click();
    await page.getByLabel("이 카드를 합칠 프로젝트", { exact: true }).selectOption("parent");
    await page.getByRole("button", { name: "선택한 프로젝트로 합치기", exact: true }).click();
    await expect(page.locator(".project-card")).toHaveCount(1);
    await expect(page.locator(".project-card h3")).toHaveText("대표 콘텐츠");
    const board = await page.evaluate(() => window.reels!.loadDashboard());
    expect(board.projects[0].resources).toHaveLength(1);
    expect(board.projects[0].production!.mergedIds).toEqual(["old-version"]);
    const backups = (await readdir(path.join(profile, "documents"))).filter(n => n.startsWith("project-merge-backup"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(profile, "documents", backups[0]), "utf8")).projects).toEqual(projects);
    expect(await readFile(resource.path, "utf8")).toBe("unchanged");
    await closeApp(app);
    app = await launchApp(profile, false);
    page = await app.firstWindow();
    await expect(page.locator(".project-card")).toHaveCount(1);
    await expect(page.locator(".project-card h3")).toHaveText("대표 콘텐츠");
  } finally { await closeApp(app); await cleanProfile(profile); }
});
