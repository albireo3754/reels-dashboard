import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test("desktop shows private credit rings and blocks unchecked submissions", async () => {
  const profile = await makeProfile();
  const observedAt = new Date(Date.now() - 10_000).toISOString();
  await writeFile(path.join(profile, "meeting-credit-observations.json"), JSON.stringify({
    openai: { observedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      totalUsd: 100, remainingUsd: 22, exclusiveSpend: false },
  }), { mode: 0o600 });
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    app = await launchApp(profile, false, {
      REELS_MEETING_API_ENABLED: "0",
      OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
      REELS_MEETING_CREDENTIALS_FILE: path.join(profile, "does-not-exist.env"),
    });
    const page = await app.firstWindow();
    await expect(page.locator(".sidebar").getByText("OpenAI", { exact: true })).toBeVisible();
    await expect(page.locator("main .meeting-credit")).toHaveCount(0);
    await page.getByRole("button", { name: "쇼츠", exact: true }).click();
    await expect(page.locator(".sidebar").getByText("Claude", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "대시보드", exact: true }).click();
    await expect(page.getByText(/입력한 잔액.*22/)).toBeVisible();
    await expect(page.getByText(/잔액 확인 안 됨/)).toBeVisible();
    await page.getByText("전사·회의록", { exact: true }).click();
    await expect(page.getByRole("button", { name: "음성 선택·전사" })).toBeDisabled();
    await page.getByRole("textbox", { name: "전사 원문" }).fill("합성 테스트 원문");
    await page.getByRole("checkbox", { name: /기존 Codex/ }).check();
    await expect(page.getByRole("button", { name: "회의록 만들기" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /AI 제공자에게 보내는/ }).check();
    await expect(page.getByRole("button", { name: "회의록 만들기" })).toBeEnabled();
  } finally {
    if (app) await closeApp(app);
    await cleanProfile(profile);
  }
});
