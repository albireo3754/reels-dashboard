import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWorkflowServer } from "../../src/app/workflow/server";

const report = [
  "**확인한 결과**와 `inline code`를 함께 표시해요.",
  "다음 줄도 유지해요.",
  "",
  "- 첫 번째 근거",
  "- 두 번째 근거",
  "",
  "| 항목 | 결과 |",
  "| --- | --- |",
  "| 안전한 표시 | 확인 |",
  "",
  "> 근거를 바탕으로 작성했어요.",
  "",
  "```ts",
  "const checked = true;",
  "```",
  "",
  "[출처](https://example.com/evidence)",
  "[실행 링크](javascript:alert(1))",
  "<script>window.reportInjected = true</script>",
  "![외부 이미지](https://example.com/private-image.png)",
].join("\n");

test("workflow history uses grouped Markdown rows and keeps result drafts when switching runs", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-channel-"));
  await writeFile(path.join(root, "source.md"), "Synthetic evidence");
  await writeFile(path.join(root, "facts.md"), "Synthetic facts");
  await writeFile(path.join(root, "draft.md"), "Synthetic draft");
  const handle = await startWorkflowServer({
    root: path.join(root, "db"),
    port: 0,
  });
  const post = async (action: string, input: unknown) => {
    const response = await fetch(handle.url + "/api/workflows/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.ok).toBeTruthy();
    return response.json();
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const images: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("private-image.png")) images.push(request.url());
  });
  try {
    let first = await post("create", {
      title: "첫 번째 제작 작업",
      workspace: root,
      instructions: "Synthetic facts only",
      trackedFiles: ["source.md"],
    });
    first = await post("submit", {
      runId: first.runId,
      taskId: first.task.taskId,
      outcome: "done",
      summary: report,
      evidence: ["facts.md"],
    });
    first = await post("submit", {
      runId: first.runId,
      taskId: first.task.taskId,
      outcome: "done",
      summary: "후속 **초안**도 검토했어요.",
      evidence: ["draft.md"],
    });
    await post("create", {
      title: "두 번째 제작 작업",
      workspace: root,
      instructions: "Second synthetic run",
      trackedFiles: ["source.md"],
    });
    await page.goto(handle.url + "/?workflow=1&run=" + first.runId);
    const history = page.getByRole("list", { name: "작업 이력", exact: true });
    await expect(history.locator(".conversation-row")).toHaveCount(2);
    await expect(
      history.locator('.conversation-row[data-grouped="true"]'),
    ).toHaveCount(1);
    await expect(history.locator(".conversation-day")).toHaveCount(1);
    await expect(
      history.locator("strong").filter({ hasText: "확인한 결과" }),
    ).toBeVisible();
    await expect(history.locator("table")).toContainText("안전한 표시");
    await expect(history.locator("pre code")).toHaveText(
      "const checked = true;\n",
    );
    await expect(history.locator(".report-markdown br").first()).toBeAttached();
    await expect(history.getByRole("link", { name: "출처" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    await expect(history.getByRole("link", { name: "실행 링크" })).toHaveCount(
      0,
    );
    await expect(history.locator("script, img")).toHaveCount(0);
    expect(images).toEqual([]);
    await page.getByLabel("판단·변경 내용").fill("저장 전 **검토 메모**");
    await page
      .getByLabel("결과·검토 근거 파일", { exact: false })
      .fill("review.md");
    await page.getByLabel("결과", { exact: true }).selectOption("revise");
    await page.getByRole("button", { name: "대시보드", exact: true }).click();
    await page.getByRole("button", { name: "워크플로", exact: true }).click();
    await expect(page.getByLabel("판단·변경 내용")).toHaveValue(
      "저장 전 **검토 메모**",
    );

    await page.getByRole("button", { name: /두 번째 제작 작업/ }).click();
    await expect(page.getByLabel("판단·변경 내용")).toHaveValue("");
    await page.getByRole("button", { name: /첫 번째 제작 작업/ }).click();
    await expect(page.getByLabel("판단·변경 내용")).toHaveValue(
      "저장 전 **검토 메모**",
    );
    await expect(
      page.getByLabel("결과·검토 근거 파일", { exact: false }),
    ).toHaveValue("review.md");
    await expect(page.getByLabel("결과", { exact: true })).toHaveValue(
      "revise",
    );
    await page.getByRole("button", { name: "결과 제출", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("판단·변경 내용")).toHaveValue(
      "저장 전 **검토 메모**",
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/workflow/channel-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/workflow/channel-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
