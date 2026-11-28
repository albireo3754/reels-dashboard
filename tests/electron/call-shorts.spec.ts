import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test("녹음 쇼츠 카드에서 입력 폴더와 최신 처리 상태를 조회한다", async () => {
  const profile = await makeProfile();
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  const inbox = path.join(profile, "inbox");
  const state = path.join(profile, "state.json");
  try {
    app = await launchApp(profile, false, { INBOX_DIR: inbox, STATE_FILE: state });
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "통화 녹음 → 유튜브 쇼츠" })).toHaveCount(0);
    await page.getByRole("button", { name: "쇼츠", exact: true }).click();
    await expect(page.getByText(/통화 녹음 폴더가 나타나기를/)).toBeVisible();
    const references = page.getByRole("region", { name: "통화 쇼츠 레퍼런스" });
    const featured = references.getByRole("link", { name: /아내 애교에 반응이 차가웠던 이유/ });
    await expect(featured).toBeVisible();
    await references.getByText("다른 레퍼런스 11편").click();
    await expect(references.getByRole("link")).toHaveCount(12);
    const urls = await references.getByRole("link").evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
    expect(new Set(urls).size).toBe(12);
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => { (globalThis as typeof globalThis & { openedReference?: string }).openedReference = url; };
    });
    await featured.click();
    await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { openedReference?: string }).openedReference))
      .toBe("https://www.youtube.com/shorts/Vm5Jz30ibOk");
    await mkdir(inbox);
    await writeFile(path.join(inbox, "sample.m4a"), "");
    await writeFile(path.join(inbox, "ignored.txt"), "");
    await writeFile(state, JSON.stringify({ files: { sample: {
      updatedAt: new Date().toISOString(), sourcePath: "/example/sample.m4a", status: "needs_review",
    } } }));
    await page.getByRole("button", { name: "현황 새로고침" }).click();
    await expect(page.getByText(/쇼츠 입력 폴더 · 녹음 1개/)).toBeVisible();
    await expect(page.getByText("sample.m4a · 검토 대기")).toBeVisible();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
