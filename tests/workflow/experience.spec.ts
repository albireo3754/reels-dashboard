import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startWorkflowServer } from "../../src/app/workflow/server";

test("one photo-backed form saves, survives reload, protects typed text during polling and advances only after all answers", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "experience-ui-"));
  const handle = await startWorkflowServer({
    root: path.join(root, "db"),
    port: 0,
  });
  const post = async (action: string, input: unknown) => {
    const res = await fetch(handle.url + "/api/workflows/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.json();
  };
  try {
    await writeFile(path.join(root, "source.md"), "Synthetic facts");
    await writeFile(
      path.join(root, "photo.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4kAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const form = {
      version: 1,
      title: "여행 경험 채우기",
      introduction: "사진을 보고 한 번에 적어주세요.",
      facts: [
        {
          text: "촬영 자료를 확인했어요.",
          source: "source.md",
          status: "confirmed",
        },
      ],
      questions: [
        {
          id: "taste",
          section: "맛",
          prompt: "어떤 맛이 기억나나요?",
          images: [{ path: "photo.png", caption: "합성 미리보기" }],
        },
        {
          id: "again",
          section: "다음 선택",
          prompt: "다시 간다면?",
          images: [],
        },
      ],
    };
    await writeFile(
      path.join(root, "experience-form.json"),
      JSON.stringify(form),
    );
    let run = await post("create", {
      title: "사진과 경험",
      workspace: root,
      instructions: "Synthetic only",
      trackedFiles: ["source.md"],
      collectExperience: true,
    });
    run = await post("submit", {
      runId: run.runId,
      taskId: run.task.taskId,
      outcome: "done",
      summary: "준비",
      evidence: ["experience-form.json"],
    });
    await page.goto(handle.url + "/?workflow=1&run=" + run.runId);
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 내 경험 채우기" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Codex로 현재 단계 실행" }),
    ).toHaveCount(0);
    await expect(page.getByAltText("합성 미리보기")).toBeVisible();
    await page
      .getByLabel("어떤 맛이 기억나나요?", { exact: true })
      .fill("소스가 기억나요!!\n다시 먹고 싶음");
    await page
      .getByRole("button", { name: "답변 임시저장", exact: true })
      .click();
    await expect(page.getByText("답변을 임시저장했어요.")).toBeVisible();
    await page.reload();
    await expect(
      page.getByLabel("어떤 맛이 기억나나요?", { exact: true }),
    ).toHaveValue("소스가 기억나요!!\n다시 먹고 싶음");
    await page.getByRole("button", { name: "한 번에 제출 · 요청 확인" }).click();
    await expect(page.getByRole("alert")).toContainText("기억나지");
    await page.getByLabel("다음 선택 답변 상태").selectOption("unknown");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/workflow/experience-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: "test-results/workflow/experience-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "한 번에 제출 · 요청 확인" }).click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 답변 요청 분류" }),
    ).toBeVisible();
    const saved = await (
      await fetch(handle.url + "/api/workflows/run?id=" + run.runId)
    ).json();
    expect(saved.experience.status).toBe("submitted");
    expect(saved.experience.answers[0].text).toBe(
      "소스가 기억나요!!\n다시 먹고 싶음",
    );
    expect(saved.trackedFiles).toContain(saved.experience.exports[0]);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
