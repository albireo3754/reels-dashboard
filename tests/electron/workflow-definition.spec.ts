import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

test("desktop bridge executes the saved YAML contract and exposes its current session context", async () => {
  const profile = await makeProfile();
  let app;
  try {
    await writeFile(path.join(profile, "brief.md"), "Synthetic fixture");
    await writeFile(
      path.join(profile, "workflow.yaml"),
      `version: 1
id: desktop-fixture
title: Desktop YAML
entry: prepare
steps:
  - id: prepare
    title: 자료 확인
    kind: task
    instruction: 합성 자료만 확인한다.
    inputs: [brief.md]
    outputs: [report.md]
    completion: [자료 확인 결과 기록]
    on: {done: $complete}
`,
    );
    app = await launchApp(profile, true);
    const page = await app.firstWindow();
    const validation = await page.evaluate(
      (input) => window.reels!.workflow!.request("validate-definition", input),
      { workspace: profile, definitionFile: "workflow.yaml" },
    );
    expect(validation.definition.id).toBe("desktop-fixture");
    const run = await page.evaluate(
      (input) => window.reels!.workflow!.request("create", input),
      {
        workspace: profile,
        definitionFile: "workflow.yaml",
        projectId: "fixture",
        title: "Desktop DSL fixture",
        instructions: "Synthetic only",
        trackedFiles: ["brief.md"],
      },
    );
    await page.getByRole("button", { name: "워크플로", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 자료 확인" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("YAML 워크플로 흐름", { exact: true }),
    ).toBeVisible();
    const context = await page.evaluate(
      (input) => window.reels!.workflow!.request("context", input),
      { runId: run.runId },
    );
    expect(context.task.taskId).toBe(run.task.taskId);
    expect(context.definition.sha256).toBe(validation.sha256);
    await writeFile(
      path.join(profile, "report.md"),
      "Inspected synthetic evidence",
    );
    await page.evaluate(
      (input) => window.reels!.workflow!.request("submit", input),
      {
        runId: run.runId,
        taskId: run.task.taskId,
        outcome: "done",
        summary: "Actual fixture check",
        evidence: ["report.md"],
      },
    );
    await expect(
      page.getByText("정의된 완료 지점에 도달했어요.", { exact: false }),
    ).toBeVisible();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
