import { test, expect } from "@playwright/test";
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { makeCanonicalFixture } from "../fixtures/canonical-content";
import { startCanonicalEditor } from "../../src/app/blog-editor/server";

test("selection formatting survives palette focus, saves exact sizes and clears only the background", async ({
  page,
}, info) => {
  const f = await makeCanonicalFixture();
  await writeFile(
    path.join(f.config.layers, "bundle-review.json"),
    JSON.stringify({
      reviews: [
        {
          bundleId: "G1",
          verdict: "needs-work",
          summary: "구절을 또렷하게 보여주세요.",
          findings: [
            {
              id: "f1",
              axis: "강조",
              severity: "권장",
              observation: "선택한 구절을 키우고 적갈색으로 강조합니다.",
              proposal: {
                layer: "emphasis",
                op: "change",
                entry: {
                  id: "T1",
                  phrase: "잠시",
                  style: { color: "rgb(166,65,50)", size: 19, weight: 700 },
                },
              },
            },
          ],
        },
      ],
    }),
  );
  const server = await startCanonicalEditor(f.config);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(server.url + "/?blogEditor=1");
    const frame = page.frameLocator('iframe[title="정본 본문 편집"]');
    const paragraph = frame.locator('[data-tid="T1"]');
    await expect(paragraph).toContainText("잠시");
    await expect(page.getByLabel("글자 크기", { exact: true })).toBeDisabled();
    const selectWord = async () =>
      paragraph.evaluate((el) => {
        el.focus();
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = w.nextNode())) {
          const at = n.textContent!.indexOf("잠시");
          if (at >= 0) {
            const r = document.createRange();
            r.setStart(n, at);
            r.setEnd(n, at + 2);
            const s = getSelection()!;
            s.removeAllRanges();
            s.addRange(r);
            break;
          }
        }
      });
    await selectWord();
    await expect(page.getByLabel("글자 크기", { exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "글자색", exact: true }).click();
    await page.getByRole("button", { name: "초록 글자", exact: true }).click();
    await page.getByLabel("글자 크기", { exact: true }).selectOption("24");
    await page.getByRole("button", { name: "굵게", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "굵게", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "배경색", exact: true }).click();
    await page
      .getByRole("button", { name: "배경색만 지우기", exact: true })
      .click();
    await page.getByRole("button", { name: "정본 저장", exact: true }).click();
    await expect(
      page.getByText("정본과 미리보기를 저장했어요.", {
        exact: false,
      }),
    ).toBeVisible();
    const entries = JSON.parse(
      await readFile(path.join(f.config.layers, "emphasis-layer.json"), "utf8"),
    ).emphasis;
    const e = entries.find((e: any) => e.phrase === "잠시");
    expect(e.style.size).toBe(24);
    expect(e.style.weight).toBe(700);
    expect(e.style.color).toBe("rgb(84,184,0)");
    expect(e.style.bg).toBeUndefined();
    await page.reload();
    await expect(paragraph).toHaveText("벤치에서 잠시 쉬었어요바람이 좋았어요");
    await selectWord();
    await expect(page.getByLabel("글자 크기", { exact: true })).toHaveValue(
      "24",
    );
    // The legacy review has no text receipt, so its format proposal is shown
    // inline next to T1 as a locked card with the reason instead of a panel comparison.
    const proposal = frame.locator('.rv-card[data-proposal="f1"]');
    await expect(proposal).toBeVisible();
    await expect(proposal.locator(".rv-reason-line")).toBeVisible();
    await expect(
      proposal.getByRole("button", { name: "적용", exact: true }),
    ).toBeDisabled();
    expect(
      await paragraph.evaluate((el) => !!el.querySelector("[data-review-ui]")),
    ).toBe(false);
    await page.screenshot({ path: info.outputPath("formatting-desktop.png") });
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(
      page.getByRole("button", { name: "검토 보기", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog", { name: "묶음 검토" })).toBeHidden();
    await page.getByRole("button", { name: "검토 보기", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "묶음 검토" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "검토 닫기" })).toBeFocused();
    await page.screenshot({
      path: info.outputPath("review-drawer-laptop.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "검토 보기", exact: true }),
    ).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("navigation", { name: "정본 묶음" }),
    ).toBeHidden();
    await page.getByRole("button", { name: /글의 흐름/ }).click();
    await expect(
      page.getByRole("navigation", { name: "정본 묶음" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /글의 흐름/ }).click();
    await page.screenshot({ path: info.outputPath("formatting-mobile.png") });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
