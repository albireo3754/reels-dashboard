import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCanonicalEditor } from "../../src/app/blog-editor/server";
import { sha256Hex } from "../../src/shared/lib/hash";
import { markupFixture } from "../fixtures/markup-editor";

test("publish sends the saved revision and the exact KST booking, or requests immediate publication", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blog-publish-"));
  const seen: unknown[] = [];
  let server: Awaited<ReturnType<typeof startCanonicalEditor>> | undefined;
  try {
    const config = await markupFixture(root);
    server = await startCanonicalEditor(config, undefined, undefined, undefined, {
      publish: async (request) => {
        const source = await readFile(config.canon, "utf8");
        expect(source).toContain("Ready for publication");
        expect(request.revision).toBe(sha256Hex(source));
        seen.push(request);
        return { terminal: "t9", spaceName: "블로그 발행 · Example article" };
      },
    });
    await page.goto(server.url + "/?blogEditor=1");
    await page.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').fill("Ready for publication");
    const publish = page.getByRole("button", { name: "발행하기" });
    const dialog = page.getByRole("dialog", { name: "네이버 블로그 발행" });
    await publish.click();
    await dialog.getByRole("button", { name: "예약 발행", exact: true }).click();
    await dialog.getByLabel("발행 날짜·시간 (한국 시간)").fill("2020-01-01T09:30");
    await dialog.getByRole("button", { name: "예약 발행 요청" }).click();
    await expect(dialog.getByRole("alert")).toContainText("앞으로의 날짜와 시간");
    expect(seen).toHaveLength(0);

    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await dialog.getByLabel("발행 날짜·시간 (한국 시간)").fill(`${day}T09:35`);
    await dialog.getByRole("button", { name: "예약 발행 요청" }).click();
    await expect(dialog.getByRole("status")).toContainText("터미널 t9");
    expect(seen).toEqual([{ mode: "scheduled", scheduledAt: `${day}T09:35:00+09:00`, revision: expect.any(String) }]);
    await dialog.getByRole("button", { name: "닫기", exact: true }).last().click();

    await publish.click();
    await dialog.getByRole("button", { name: "즉시 발행 요청" }).click();
    await expect(dialog.getByRole("status")).toContainText("터미널 t9");
    expect(seen[1]).toEqual({ mode: "now", revision: expect.any(String) });

    const rejected = await page.evaluate(async () => (await fetch("/api/blog/publish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "now", revision: "0".repeat(64) }),
    })).status);
    expect(rejected).toBe(409);
    expect(seen).toHaveLength(2);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
