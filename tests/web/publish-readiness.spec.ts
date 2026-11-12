import { expect, test } from "@playwright/test";

const base = { date: "2026-11-01", nextAction: "", publicURL: "", shared: false };
const sha = "a".repeat(64);
const deliveredOutbound = (folder: string, roles: string[]) => ({
  directory: `/demo/cloud/${folder}`,
  generation: 1,
  updatedAt: "2026-11-12T00:00:00.000Z",
  files: roles.map((role) => ({ name: `${role}.bin`, role, bytes: 1, sha256: sha })),
});
const instagramPlanned = [{ channel: "instagram", status: "planned", url: "" }];
const readinessProjects = [
  { ...base, id: "ready", title: "올릴 준비 끝", stage: "review", publications: instagramPlanned, outbound: deliveredOutbound("ready", ["final", "cover", "document"]) },
  { ...base, id: "no-post", title: "게시글 없음", stage: "review", publications: instagramPlanned, outbound: deliveredOutbound("no-post", ["final", "cover"]) },
  { ...base, id: "undelivered", title: "전달 전", stage: "review", publications: instagramPlanned },
];

test.describe("instagram readiness", () => {
  test("planned Instagram chip shows whether the iCloud outbound is ready to post", async ({ page }) => {
    await page.addInitScript((projects) => {
      localStorage.setItem(
        "reels-dashboard-demo-v1",
        JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-12T00:00:00Z", projects }),
      );
    }, readinessProjects);
    await page.goto("/?demo=1");
    const chip = (title: string) =>
      page.locator(".project-card", { hasText: title }).locator(".project-channels li").first();
    await expect(chip("올릴 준비 끝")).toHaveText("인스타그램 · 게시 준비 완료");
    await expect(chip("올릴 준비 끝")).toHaveAttribute("data-readiness", "ready");
    await expect(chip("게시글 없음")).toHaveText("인스타그램 · 전달 파일 부족");
    await expect(chip("게시글 없음")).toHaveAttribute("title", /게시글/);
    await expect(chip("전달 전")).toHaveText("인스타그램 · 예정");
  });
});
