import { test, expect } from "@playwright/test";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { startCanonicalEditor } from "../../src/app/blog-editor/server";
import { makeCanonicalFixture } from "../fixtures/canonical-content";

test("edits actual canonical rich text, persists formatting, queues only on signal, and protects concurrent edits", async ({
  page,
}, info) => {
  const fixture = await makeCanonicalFixture();
  const server = await startCanonicalEditor(fixture.config);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(server.url + "/?blogEditor=1");
    const frame = page.frameLocator('iframe[title="정본 본문 편집"]');
    await expect(frame.getByRole("textbox", { name: "T1 문단" })).toContainText(
      "벤치에서",
    );
    await expect(frame.getByRole("img", { name: "산책 풍경" })).toBeVisible();
    await frame
      .getByRole("textbox", { name: "T2 문단" })
      .fill("차를 천천히 마셨어요");
    expect(await readFile(fixture.config.canon, "utf8")).toBe(fixture.raw);
    await expect(
      page.getByRole("button", { name: "정본 저장", exact: true }),
    ).toBeEnabled();
    await frame.getByRole("textbox", { name: "T1 문단" }).evaluate((el) => {
      el.focus();
      const text = el.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole("button", { name: "글자색", exact: true }).click();
    await page.getByRole("button", { name: "적갈색 글자" }).click();
    await page.getByRole("button", { name: "정본 저장", exact: true }).click();
    await expect(
      page.getByText("정본과 미리보기를 저장했어요.", {
        exact: false,
      }),
    ).toBeVisible();
    const saved = await readFile(fixture.config.canon, "utf8");
    expect(saved).toContain("차를 천천히 마셨어요");
    expect(saved).toContain("color:rgb(166,65,50)");
    expect(saved).toContain("개인 기록 보존");
    expect(saved).toContain("〔사진: photo.svg〕");
    expect(
      await readdir(path.join(fixture.config.layers, "editor-requests")).catch(
        () => [],
      ),
    ).toHaveLength(0);
    await page.reload();
    await expect(frame.getByRole("textbox", { name: "T2 문단" })).toHaveText(
      "차를 천천히 마셨어요",
    );
    await page
      .getByRole("button", { name: "이 묶음 검토", exact: true })
      .click();
    await expect(
      page.getByText("검토 요청됨 · 엔진 처리 대기", { exact: true }),
    ).toBeVisible();
    expect(
      await readdir(path.join(fixture.config.layers, "editor-requests")),
    ).toHaveLength(1);
    await page.screenshot({
      path: info.outputPath("canonical-editor-desktop.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: info.outputPath("canonical-editor-mobile.png"),
      fullPage: false,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await writeFile(fixture.config.canon, saved + "다른 세션 기록\n");
    await frame
      .getByRole("textbox", { name: "T2 문단" })
      .fill("저장 충돌 확인");
    await page.getByRole("button", { name: "정본 저장", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("다른 세션");
    expect(await readFile(fixture.config.canon, "utf8")).toBe(
      saved + "다른 세션 기록\n",
    );
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
