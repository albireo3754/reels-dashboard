import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWorkflowServer } from "../../src/app/workflow/server";
import type { SdkFactory } from "../../src/app/workflow/codex-executor";

test("dashboard explicitly executes one SDK step and displays the shared job", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "sdk-ui-"));
  await writeFile(path.join(root, "source.md"), "Synthetic source only");
  const sdkFactory: SdkFactory = (options) => ({
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          const setting = options.configOverrides!.find((v) =>
            v.startsWith("otel.exporter="),
          )!;
          const endpoint = JSON.parse(setting.match(/endpoint=("[^"]+")/)![1]);
          await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resourceLogs: [
                {
                  scopeLogs: [
                    {
                      logRecords: [
                        {
                          attributes: [
                            {
                              key: "model",
                              value: { stringValue: "fixture-sdk-model" },
                            },
                            {
                              key: "reasoning_effort",
                              value: { stringValue: "low" },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          });
          yield {
            type: "item.completed" as const,
            item: {
              id: "answer",
              type: "agent_message" as const,
              text: JSON.stringify({
                outcome: "done",
                summary: "Prepared synthetic facts",
                artifacts: [
                  { name: "facts.md", content: "Synthetic facts only" },
                ],
              }),
            },
          };
          yield {
            type: "turn.completed" as const,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
          };
        })(),
      }),
    }),
  });
  const handle = await startWorkflowServer({
    root: path.join(root, "db"),
    port: 0,
    sdkFactory,
    sdkEnv: {},
  });
  try {
    await fetch(handle.url + "/api/workflows/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "SDK 합성 실행",
        workspace: root,
        trackedFiles: ["source.md"],
        instructions: "Use synthetic facts only",
      }),
    });
    await page.goto(handle.url + "/?workflow=1");
    await page.getByRole("button", { name: "Codex로 현재 단계 실행" }).click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 초안 작성" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Codex 실행 상태" }),
    ).toContainText("Codex 로그인");
    await expect(
      page.getByRole("region", { name: "Codex 실행 상태" }),
    ).toContainText("완료");
    await expect(page.getByLabel("모델·사용량·예상 비용")).toContainText(
      "fixture-sdk-model",
    );
    await expect(page.getByLabel("모델·사용량·예상 비용")).toContainText(
      "API 비용 산정 대상 아님",
    );
    await page.screenshot({
      path: "test-results/workflow/sdk-dashboard.png",
      fullPage: true,
    });
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("web controls a persistent external-work run, desktop and mobile", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "reels-workflow-ui-"));
  await writeFile(path.join(root, "source.md"), "Synthetic source evidence");
  await writeFile(path.join(root, "facts.md"), "Synthetic prepared facts");
  let handle = await startWorkflowServer({
    root: path.join(root, "db"),
    port: 0,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(handle.url + "/?workflow=1");
    await expect(
      page.getByRole("heading", { name: "제작 워크플로" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "새 워크플로", exact: true })
      .click();
    await page.getByLabel("제목", { exact: true }).fill("합성 검증 글");
    await page.getByLabel("작업 폴더", { exact: true }).fill(root);
    await page
      .getByLabel("작성·검토 기준")
      .fill("합성 근거에 따라 작성하고 실제 화면을 검토한다.");
    await page.getByLabel("기존 근거 파일", { exact: false }).fill("source.md");
    await page.getByLabel("자료 준비 후 내 경험을 한 폼으로 받기").uncheck();
    await page.getByRole("button", { name: "워크플로 시작" }).click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 근거 준비" }),
    ).toBeVisible();
    await page
      .getByLabel("판단·변경 내용")
      .fill("근거 파일을 확인하고 준비 문서를 작성했다.");
    await page
      .getByLabel("결과·검토 근거 파일", { exact: false })
      .fill("facts.md");
    await page.getByRole("button", { name: "결과 제출", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 초안 작성" }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/workflow/desktop.png",
      fullPage: true,
    });
    const oldUrl = handle.url;
    await handle.close();
    handle = await startWorkflowServer({
      root: path.join(root, "db"),
      port: Number(new URL(oldUrl).port),
    });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 초안 작성" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/workflow/mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByLabel("결과", { exact: true }).selectOption("blocked");
    await page
      .getByLabel("판단·변경 내용")
      .fill("사용자의 추가 경험을 기다린다.");
    await page.getByRole("button", { name: "결과 제출", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "다시 검토", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "다시 검토", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "현재 요청 · 초안 작성" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
