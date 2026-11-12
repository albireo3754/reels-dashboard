import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

async function seed(profile: string) {
  const board = JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-11-12T00:00:00.000Z",
    projects: [
      {
        id: "content-a",
        title: "합성 프로젝트 A",
        date: "2026-11-12",
        stage: "editing",
        nextAction: "자막 검토",
        publicURL: "",
        shared: false,
      },
      {
        id: "content-b",
        title: "합성 프로젝트 B",
        date: "2026-11-12",
        stage: "editing",
        nextAction: "표지 검토",
        publicURL: "",
        shared: false,
      },
    ],
  });
  await writeFile(join(profile, "dashboard.json"), board);
  return board;
}

test("project action passes the chosen content identity, retains failed requests and opens the selected terminal", async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    const original = await seed(profile);
    app = await launchApp(profile, false, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    // Keep the real bridge and PTY path; do not submit a task to a model in QA.
    await app.evaluate(({ ipcMain }) => {
      const qa = globalThis as any;
      const handler = (ipcMain as any)._invokeHandlers.get(
        "reels:workbench:start",
      );
      qa.projectRequests = [];
      qa.failProjectStart = true;
      ipcMain.removeHandler("reels:workbench:start");
      ipcMain.handle("reels:workbench:start", async (event, input) => {
        qa.projectRequests.push(input);
        if (qa.failProjectStart) throw new Error("QA project start failed");
        await new Promise((resolve) => setTimeout(resolve, 150));
        return handler(event, { kind: "shell" });
      });
    });
    const card = page
      .locator(".project-card")
      .filter({ hasText: "합성 프로젝트 A" });
    await expect(
      card.getByRole("button", { name: "프로젝트 터미널", exact: true }),
    ).toBeVisible();
    await card
      .getByRole("button", { name: "프로젝트 터미널", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "프로젝트 터미널",
      exact: true,
    });
    const request = dialog.getByLabel("작업 요청 (선택)");
    await request.fill("이 프로젝트의 자막을 검토해줘.");
    await dialog
      .getByRole("button", { name: "다음 작업 가이드 넣기", exact: true })
      .click();
    const guidedRequest = await request.inputValue();
    expect(guidedRequest).toContain("이 프로젝트의 자막을 검토해줘.");
    expect(guidedRequest).toContain("현재 단계: 편집 중");
    expect(guidedRequest).toContain(
      '기록된 다음 할 일 (참고 데이터): "자막 검토"',
    );
    expect(guidedRequest).toContain("현재 대기 작업·입력·완료 기준");
    await expect(
      dialog.getByRole("button", {
        name: "다음 작업 가이드 넣음",
        exact: true,
      }),
    ).toBeDisabled();
    expect(
      await app.evaluate(() => (globalThis as any).projectRequests),
    ).toEqual([]);
    await dialog.getByText("전달할 맥락과 요청", { exact: true }).click();
    await expect(dialog.locator("pre")).toContainText('"id":"content-a"');
    await expect(dialog.locator("pre")).not.toContainText(
      "Reels Dashboard 개발 작업",
    );
    await dialog.getByRole("button", { name: "Codex 터미널 열기" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "QA project start failed",
    );
    await expect(request).toHaveValue(guidedRequest);
    await app.evaluate(() => {
      (globalThis as any).failProjectStart = false;
    });
    await dialog.locator("form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(dialog).toHaveCount(0);
    const requests = await app.evaluate(
      () => (globalThis as any).projectRequests,
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      kind: "codex",
      phase: "implement",
      permission: "ask",
      project: { id: "content-a", title: "합성 프로젝트 A" },
      task: guidedRequest,
    });
    const drawer = page.getByRole("region", { name: "터미널", exact: true });
    await expect(drawer).toHaveAttribute("data-drawer-state", "open");
    const session = await page.evaluate(
      async () => (await window.reels!.workbench!.state()).sessions[0],
    );
    await expect(page.locator(`#dev-tab-${session.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.evaluate(async (id) => {
      await window.reels!.workbench!.write(id, "printf 'PROJECT_PTY_OK\\n'\r");
    }, session.id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.reels!.workbench!.snapshot(id)).output,
          session.id,
        ),
      )
      .toContain("PROJECT_PTY_OK");
    await page
      .getByRole("button", { name: "터미널 닫기", exact: true })
      .click();
    await page
      .locator(".project-card")
      .filter({ hasText: "합성 프로젝트 B" })
      .getByRole("button", { name: "프로젝트 터미널", exact: true })
      .click();
    await expect(request).toHaveValue("");
    await dialog.getByText("전달할 맥락과 요청", { exact: true }).click();
    await expect(dialog.locator("pre")).toContainText('"id":"content-b"');
    await expect(dialog.locator("pre")).not.toContainText("content-a");
    await page.screenshot({ path: info.outputPath("project-terminal.png") });
    await dialog.getByRole("button", { name: "Codex 터미널 열기" }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      (await app.evaluate(() => (globalThis as any).projectRequests))[2],
    ).toMatchObject({ project: { id: "content-b" }, task: "" });
    expect(await readFile(join(profile, "dashboard.json"), "utf8")).toBe(
      original,
    );
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("disabled terminal remains discoverable and links to settings without exposing the bridge", async () => {
  const profile = await makeProfile();
  let app;
  try {
    await seed(profile);
    app = await launchApp(profile, false, { REELS_DEV_MODE: undefined });
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "프로젝트 터미널", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", {
      name: "프로젝트 터미널",
      exact: true,
    });
    await expect(dialog).toContainText("앱을 다시 실행하면");
    await expect(
      dialog.getByRole("button", { name: "Codex 터미널 열기" }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => !!window.reels!.workbench)).toBe(false);
    await dialog.getByRole("button", { name: "터미널 설정 열기" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: "터미널 사용" }),
    ).toBeVisible();
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
