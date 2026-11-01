import { test, expect } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { startCanonicalEditor } from "../../src/app/blog-editor/server";
import { startWorkflowServer } from "../../src/app/workflow/server";
import type { SdkFactory } from "../../src/app/workflow/codex-executor";
import { makeCanonicalFixture } from "../fixtures/canonical-content";

test("standalone blog UI proxies the shared SDK service and applies only on explicit choice", async ({ page }, info) => {
  const fixture = await makeCanonicalFixture();
  const factory: SdkFactory = () => ({ startThread: () => ({ runStreamed: async (prompt) => ({ events: (async function* () {
    const request = JSON.parse(prompt.split("Request: ")[1].split("\nReturn resultJson")[0]);
    const bundleId = request.bundleIds[0], before = request.bundles.find((b: any) => b.id === bundleId).blocks[0];
    const result = { schemaVersion: 1, kind: "blog.bundle-review.result", requestId: request.requestId, reviews: [{ bundleId, verdict: "revise", summary: "합성 SDK 문안 제안", findings: [{ id: "sdk-example", bundleId, blockId: before.id, reason: "합성 검증을 위한 문장 수정", before, after: { ...before, text: "벤치에서 잠깐 쉬어갔어요" } }] }] };
    yield { type: "item.completed" as const, item: { id: "answer", type: "agent_message" as const, text: JSON.stringify({ resultJson: JSON.stringify(result) }) } };
    yield { type: "turn.completed" as const, usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
  })() }) }) });
  const backend = await startWorkflowServer({ root: path.join(fixture.root, "sdk-db"), port: 0, sdkFactory: factory, sdkEnv: {} });
  const previousUrl = process.env.REELS_WORKFLOW_URL;
  process.env.REELS_WORKFLOW_URL = backend.url;
  const editor = await startCanonicalEditor(fixture.config);
  try {
    await page.goto(editor.url + "/?blogEditor=1");
    const frame = page.frameLocator('iframe[title="정본 본문 편집"]');
    await page.getByRole("button", { name: "Codex로 선택 묶음 검토" }).click();
    await expect(page.getByText("합성 SDK 문안 제안")).toBeVisible();
    expect(await readFile(fixture.config.canon, "utf8")).toBe(fixture.raw);
    await page.screenshot({ path: info.outputPath("canonical-sdk.png"), fullPage: true });
    await page.getByRole("button", { name: "SDK 제안 적용" }).click();
    await expect(frame.getByRole("textbox", { name: "T1 문단" })).toContainText("벤치에서 잠깐 쉬어갔어요");
    expect(await readFile(fixture.config.canon, "utf8")).toBe(fixture.raw);
    await expect(page.getByRole("button", { name: "SDK 제안 적용" })).toBeDisabled();
    await page.getByRole("button", { name: "정본 저장", exact: true }).click();
    await expect.poll(() => readFile(fixture.config.canon, "utf8")).toContain("벤치에서 잠깐 쉬어갔어요");
  } finally {
    await editor.close(); await backend.close();
    if (previousUrl === undefined) delete process.env.REELS_WORKFLOW_URL; else process.env.REELS_WORKFLOW_URL = previousUrl;
    await rm(fixture.root, { recursive: true, force: true });
  }
});
