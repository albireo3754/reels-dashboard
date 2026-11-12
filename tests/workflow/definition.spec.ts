import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWorkflowServer } from "../../src/app/workflow/server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const yaml = `version: 1
id: ui-fixture
title: YAML 제작 흐름
entry: make
steps:
  - id: make
    title: 시안 제작
    kind: task
    instruction: 근거를 보고 시안을 작성한다.
    inputs: [brief.md]
    outputs: [draft.md]
    skills: [fixture-skill]
    tools: [{server: reels_dashboard, name: reels_get_app_state, purpose: 앱 상태 조회}]
    completion: [근거가 시안에 반영됨]
    on: {done: inspect}
  - id: inspect
    title: 시안 확인
    kind: review
    instruction: 실제 시안을 확인하고 근거를 기록한다.
    inputs: [draft.md]
    outputs: ['review-{attempt}.md']
    completion: [검토 판단 기록]
    on: {pass: $complete, revise: make}
`;

test("YAML UI, real MCP and CLI share one persisted run and display its topology/state", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "dsl-ui-"));
  await writeFile(path.join(root, "brief.md"), "Synthetic confirmed facts");
  await writeFile(path.join(root, "workflow.yaml"), yaml);
  let handle = await startWorkflowServer({
    root: path.join(root, "db"),
    port: 0,
  });
  const client = new Client({ name: "dsl-e2e", version: "1" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/app/workflow/mcp.ts"],
        env: { ...process.env, REELS_WORKFLOW_URL: handle.url } as Record<
          string,
          string
        >,
        stderr: "pipe",
      }),
    );
    const validation = await client.callTool({
      name: "reels_workflow_validate-definition",
      arguments: { workspace: root, definitionFile: "workflow.yaml" },
    });
    expect(validation.isError).toBeUndefined();
    await page.goto(handle.url + "/?workflow=1");
    await page
      .getByRole("button", { name: "새 워크플로", exact: true })
      .click();
    await page.getByLabel("제목", { exact: true }).fill("합성 DSL 실행");
    await page.getByLabel("작업 폴더", { exact: true }).fill(root);
    await page
      .getByLabel("워크플로 YAML", { exact: false })
      .fill("workflow.yaml");
    await page
      .getByLabel("연결할 프로젝트 ID", { exact: false })
      .fill("synthetic-project");
    await page.getByLabel("작성·검토 기준").fill("합성 자료만 사용한다.");
    await page.getByLabel("기존 근거 파일", { exact: false }).fill("brief.md");
    await page
      .getByRole("button", { name: "워크플로 시작", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 시안 제작" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("YAML 워크플로 흐름", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "시안 제작 · 현재", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "시안 확인 · 대기", exact: true })
      .click();
    await expect(page.getByLabel("선택한 단계 계약")).toContainText(
      "review-{attempt}.md",
    );
    await expect(page.getByLabel("선택한 단계 계약")).toContainText(
      "수정 → 시안 제작",
    );
    await page.getByText("Codex 세션에서 이어가기", { exact: true }).click();
    const list = await fetch(handle.url + "/api/workflows").then((r) =>
      r.json(),
    );
    let run = list.runs[0];
    const context = await client.callTool({
      name: "reels_workflow_context",
      arguments: { runId: run.runId },
    });
    expect((context.structuredContent as any).task.taskId).toBe(
      run.task.taskId,
    );
    expect((context.structuredContent as any).projectId).toBe(
      "synthetic-project",
    );
    await writeFile(path.join(root, "draft.md"), "Synthetic draft");
    const result = await client.callTool({
      name: "reels_workflow_submit",
      arguments: {
        runId: run.runId,
        taskId: run.task.taskId,
        outcome: "done",
        summary: "Created actual fixture draft",
        evidence: ["draft.md"],
      },
    });
    expect(result.isError).toBeUndefined();
    run = result.structuredContent;
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 시안 확인" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "시안 확인 · 현재", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "시안 확인 · 현재", exact: true })
      .click();
    await page.screenshot({
      path: "test-results/workflow/dsl-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 시안 확인" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/workflow/dsl-mobile.png",
      fullPage: true,
    });
    await client.close();
    const oldTask = run.task.taskId;
    await handle.close();
    handle = await startWorkflowServer({
      root: path.join(root, "db"),
      port: 0,
    });
    const cli = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/app/workflow/main.ts", "context", run.runId],
      { env: { ...process.env, REELS_WORKFLOW_URL: handle.url } },
    );
    expect(JSON.parse(cli.stdout).task.taskId).toBe(oldTask);
    await page.goto(handle.url + "/?workflow=1&run=" + run.runId);
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 시안 확인" }),
    ).toBeVisible();
    await writeFile(
      path.join(root, run.task.step.outputs[0]),
      "Inspected the synthetic draft",
    );
    await page.getByLabel("판단·변경 내용").fill("실제 합성 시안 검토 완료");
    await page
      .getByLabel("결과·검토 근거 파일", { exact: false })
      .fill(run.task.step.outputs[0]);
    await page.getByRole("button", { name: "결과 제출", exact: true }).click();
    await expect(
      page.getByText("정의된 완료 지점에 도달했어요.", { exact: false }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await client.close().catch(() => {});
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("UI creates a run from the built-in blog definition with a local guide", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "dsl-builtin-"));
  const workspace = path.join(root, "research", "post");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(root, "workflows"));
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(workspace, "brief.md"), "Synthetic brief");
  await writeFile(path.join(root, "notes", "rules.md"), "Synthetic rules");
  const guideFile = path.join(root, "workflows", "guides.yaml");
  await writeFile(
    guideFile,
    "version: 1\ndefinition: blog\nsteps:\n  prepare:\n    docs: [notes/rules.md]\n    instruction: 합성 로컬 지시.\n    skills: [fixture-skill]\n",
  );
  const handle = await startWorkflowServer({
    root: path.join(root, "db"),
    port: 0,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(handle.url + "/?workflow=1");
    await page
      .getByRole("button", { name: "새 워크플로", exact: true })
      .click();
    await page.getByLabel("제목", { exact: true }).fill("내장 정의 실행");
    await page.getByLabel("작업 폴더", { exact: true }).fill(workspace);
    await page
      .getByLabel("앱 내장 워크플로", { exact: false })
      .selectOption("blog");
    await expect(
      page.getByLabel("워크플로 YAML", { exact: false }),
    ).toBeDisabled();
    await page.getByLabel("로컬 가이드 파일", { exact: false }).fill(guideFile);
    await page.getByLabel("작성·검토 기준").fill("합성 자료만 사용한다.");
    await page.getByLabel("기존 근거 파일", { exact: false }).fill("brief.md");
    await page
      .getByRole("button", { name: "워크플로 시작", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 촬영분 분석·장면 목록" }),
    ).toBeVisible();
    await expect(page.getByText("합성 로컬 지시.").first()).toBeVisible();
    await page
      .getByRole("button", { name: "촬영분 분석·장면 목록 · 현재", exact: true })
      .click();
    await expect(page.getByLabel("선택한 단계 계약")).toContainText(
      "로컬 가이드",
    );
    await expect(page.getByLabel("선택한 단계 계약")).toContainText(
      "notes/rules.md",
    );
    const { runs } = await fetch(handle.url + "/api/workflows").then((r) =>
      r.json(),
    );
    expect(runs[0].definition.file).toBe("builtin:blog");
    expect(runs[0].task.step.skills).toContain("fixture-skill");
    expect(errors).toEqual([]);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
