import { expect, test } from "@playwright/test";

test("inspection requires development capability", async ({ page }) => {
  await page.goto("/tests/web/fixtures/ui-inspector.html");
  await expect(
    page.getByRole("button", { name: "화면 검사", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+c");
  await expect(page.getByText("수정할 화면 요소를 선택하세요.")).toHaveCount(0);
});

test("inspection blocks underlying action and appends only explicit feedback to an existing draft", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/tests/web/fixtures/ui-inspector.html?enabled=1");
  await page.getByRole("button", { name: "터미널", exact: true }).click();
  await page
    .getByText("소스 연결 · 개선 요청 · 코딩 도구", { exact: true })
    .click();
  await page.locator("#dev-task").fill("기존 요청을 유지해주세요.");
  await page.getByRole("button", { name: "터미널 닫기", exact: true }).click();
  await page.getByRole("button", { name: "화면 검사", exact: true }).click();
  await expect(page.locator(".ui-inspector-banner")).toBeVisible();
  const editor = page.getByRole("button", { name: "영상 편집", exact: true });
  await editor.hover();
  await expect(page.locator(".ui-inspector-outline")).toBeVisible();
  await editor.click();
  const dialog = page.getByRole("dialog", { name: "화면 수정 요청" });
  await expect(dialog).toBeVisible();
  await expect(
    page.locator(".sidebar button[aria-current=page]"),
  ).toHaveAttribute("aria-label", "대시보드");
  await expect(dialog.getByLabel("선택 요소 코드 위치")).toContainText(
    "src/renderer/App.tsx",
  );
  await expect(
    dialog.getByRole("button", { name: "개선 요청에 추가", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "수정할 내용" })
    .fill("선택 메뉴의 글자를 더 잘 보이게 해주세요.");
  await page.screenshot({ path: info.outputPath("ui-inspector.png") });
  await dialog
    .getByRole("button", { name: "개선 요청에 추가", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const draft = page.locator("#dev-task");
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue(
    /기존 요청을 유지해주세요\.[\s\S]*선택 메뉴의 글자를 더 잘 보이게 해주세요\./,
  );
  await expect(draft).not.toHaveValue(/도쿄의 오후 산책/);
  await expect(page.getByRole("tab", { name: /Codex/ })).toHaveCount(0);
  await page.getByRole("button", { name: "터미널 닫기", exact: true }).click();
  await page.keyboard.press("Meta+Shift+c");
  await expect(page.locator(".ui-inspector-banner")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ui-inspector-banner")).toHaveCount(0);
  await editor.click();
  await expect(
    page.locator(".sidebar button[aria-current=page]"),
  ).toHaveAttribute("aria-label", "영상 편집");
});

test("multiple pending inspection notes survive a full request draft", async ({
  page,
}) => {
  await page.goto("/tests/web/fixtures/ui-inspector.html?enabled=1");
  await page.getByRole("button", { name: "터미널", exact: true }).click();
  await page
    .getByText("소스 연결 · 개선 요청 · 코딩 도구", { exact: true })
    .click();
  await page.locator("#dev-task").fill("x".repeat(15990));
  for (const comment of [
    "첫 번째 의견을 보존해주세요.",
    "두 번째 의견도 보존해주세요.",
  ]) {
    await page
      .getByRole("button", { name: "터미널 닫기", exact: true })
      .click();
    await page.getByRole("button", { name: "화면 검사", exact: true }).click();
    await expect(page.locator(".ui-inspector-banner")).toBeVisible();
    await page.getByRole("button", { name: "영상 편집", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "화면 수정 요청" });
    await dialog.getByRole("textbox", { name: "수정할 내용" }).fill(comment);
    await dialog
      .getByRole("button", { name: "개선 요청에 추가", exact: true })
      .click();
    await expect(page.locator("#dev-task")).toHaveValue("x".repeat(15990));
  }
  await page.locator("#dev-task").fill("요청을 줄였어요.");
  await expect(page.locator("#dev-task")).toHaveValue(
    /요청을 줄였어요\.[\s\S]*첫 번째 의견을 보존해주세요\.[\s\S]*두 번째 의견도 보존해주세요\./,
  );
  const value = await page.locator("#dev-task").inputValue();
  expect(value.match(/첫 번째 의견을 보존해주세요/g)).toHaveLength(1);
  expect(value.match(/두 번째 의견도 보존해주세요/g)).toHaveLength(1);
});

test("inspection prevents embedded preview clicks from executing", async ({
  page,
}) => {
  await page.goto("/tests/web/fixtures/ui-inspector.html?enabled=1");
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.title = "Synthetic preview";
    frame.style.cssText =
      "position:fixed;top:200px;left:450px;width:400px;height:200px;z-index:100";
    frame.srcdoc =
      "<button onclick=\"parent.document.body.dataset.previewClicked='yes'\">Preview action</button>";
    document.body.append(frame);
  });
  const preview = page
    .frameLocator('iframe[title="Synthetic preview"]')
    .getByRole("button", { name: "Preview action" });
  await expect(preview).toBeVisible();
  await page.getByRole("button", { name: "화면 검사", exact: true }).click();
  await expect(page.locator(".ui-inspector-banner")).toBeVisible();
  expect(
    await page
      .locator('iframe[title="Synthetic preview"]')
      .evaluate((frame) => getComputedStyle(frame).pointerEvents),
  ).toBe("none");
  await page.mouse.click(475, 225);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-preview-clicked",
    "yes",
  );
  await page.keyboard.press("Escape");
  await preview.click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-preview-clicked",
    "yes",
  );
});

test("inspection moves keyboard focus out of a preview and restores it on Escape", async ({
  page,
}) => {
  await page.goto("/tests/web/fixtures/ui-inspector.html?enabled=1");
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.title = "Keyboard preview";
    frame.srcdoc = "<button>Preview keyboard action</button>";
    document.body.append(frame);
  });
  const preview = page
    .frameLocator('iframe[title="Keyboard preview"]')
    .getByRole("button", { name: "Preview keyboard action" });
  await preview.focus();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "IFRAME",
  );
  // The Electron native hook emits onShortcut in the parent renderer even when
  // a child frame holds focus. Reproduce that delivery without moving focus.
  await page.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyC",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    ),
  );
  await expect(
    page.getByRole("button", { name: "검사 끝내기 · Esc" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ui-inspector-banner")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "IFRAME",
  );
});
