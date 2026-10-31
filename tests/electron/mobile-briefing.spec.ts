import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test("briefing card reads server confirmation, opens the configured site, and reflects service loss", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    const directory = join(profile, "mobile-bridge");
    await mkdir(directory);
    const status = {
      siteUrl: "https://example.chatgpt.site",
      connected: true,
      checkedAt: new Date().toISOString(),
      syncedAt: "2026-10-28T00:00:00.000Z",
      contentCount: 2,
      assetCount: 3,
    };
    await writeFile(join(directory, "status.json"), JSON.stringify(status));
    app = await launchApp(profile);
    const page = await app.firstWindow();
    const card = page.getByRole("region", { name: "모바일 브리핑" });
    await expect(card).toContainText("동기화 서비스 연결됨");
    await expect(card).toContainText("콘텐츠·촬영 묶음 2개 · 자료 3개");
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        (globalThis as any).briefingOpenedURL = url;
      };
    });
    await card.getByRole("button", { name: "브리핑 사이트 열기" }).click();
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).briefingOpenedURL))
      .toBe(status.siteUrl);
    await page.screenshot({
      path: testInfo.outputPath("briefing-connected.png"),
      fullPage: true,
    });
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify({ ...status, checkedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await expect(card).toContainText("동기화 서비스 연결 끊김", {
      timeout: 15000,
    });
    await expect(card).toContainText("콘텐츠·촬영 묶음 2개");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(card).toBeVisible();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
