import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import {
  cleanProfile,
  closeApp,
  launchApp,
  makeProfile,
  pressWorkbenchKey,
} from "./helpers";

test("real PTY input, tab reattach, resize, source lock and explicit lifecycle", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "개발 작업공간", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "개발 작업공간" }),
    ).toContainText(resolve("."));
    await page
      .getByText("소스 연결 · 개선 요청 · 코딩 도구", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "일반 터미널", exact: true })
      .click();
    await expect(page.locator(".dev-session-tabs")).toContainText("실행 중");
    const id = await page.evaluate(
      async () => (await window.reels!.workbench!.state()).sessions[0].id,
    );
    await page.evaluate(async (id) => {
      await window.reels!.workbench!.write(
        id,
        "printf '\\x50\\x54\\x59_READY\\n'; pwd\r",
      );
      await window.reels!.workbench!.resize(id, 101, 29);
    }, id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.reels!.workbench!.snapshot(id)).output,
          id,
        ),
      )
      .toContain("PTY_READY");
    await page.getByRole("button", { name: "대시보드", exact: true }).click();
    await page
      .getByRole("button", { name: "개발 작업공간", exact: true })
      .click();
    await expect(
      page.locator(`.dev-terminal[data-session-id="${id}"]`),
    ).toContainText("PTY_READY");
    await page
      .locator(`.dev-terminal[data-session-id="${id}"] .xterm-helper-textarea`)
      .focus();
    await page.keyboard.type("printf '\\x4b\\x45\\x59_INPUT\\n'");
    await page.keyboard.press("Enter");
    await expect(
      page.locator(`.dev-terminal[data-session-id="${id}"]`),
    ).toContainText("KEY_INPUT");
    await page
      .getByRole("button", { name: "일반 터미널", exact: true })
      .click();
    await page
      .getByRole("tablist", { name: "터미널 세션" })
      .getByRole("tab")
      .first()
      .click();
    await expect(
      page.locator(`.dev-terminal[data-session-id="${id}"]`),
    ).toContainText("PTY_READY");
    const second = await page.evaluate(
      async () => (await window.reels!.workbench!.state()).sessions[1].id,
    );
    await page.evaluate(
      async (id) => window.reels!.workbench!.stop(id),
      second,
    );
    await app.evaluate(({ dialog }, repo) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [repo],
      });
    }, resolve("."));
    await page.getByRole("button", { name: "소스 폴더 연결" }).click();
    await expect(page.getByRole("alert")).toContainText("실행 중인 세션");
    await page.evaluate(async (id) => {
      await window.reels!.workbench!.write(id, "exit 7\r");
    }, id);
    await expect(page.locator(".dev-session-tabs")).toContainText("종료 7");
    await page.screenshot({
      path: testInfo.outputPath("workbench.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "목록에서 지우기" }).click();
    await expect(
      page.getByRole("tablist", { name: "터미널 세션" }).getByRole("tab"),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "소스 폴더 연결" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("preview server shows real dashboard without desktop bridge and stops cleanly", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "개발 작업공간", exact: true })
      .click();
    await page.getByRole("button", { name: "미리보기 서버 시작" }).click();
    const session = await page.evaluate(
      async () => (await window.reels!.workbench!.state()).sessions[0],
    );
    await expect
      .poll(async () => {
        try {
          const response = await fetch("http://127.0.0.1:4183", {
            signal: AbortSignal.timeout(1000),
          });
          return response.ok;
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(
      await page.evaluate(
        async (id) =>
          (await window.reels!.workbench!.snapshot(id)).session.state,
        session.id,
      ),
    ).toBe("running");
    await page.getByRole("button", { name: "미리보기 나란히 보기" }).click();
    const frame = page.frameLocator('iframe[title="로컬 대시보드 미리보기"]');
    await expect(
      frame.getByRole("heading", { name: "작업의 흐름을 한눈에" }),
    ).toBeVisible();
    await expect(
      frame.getByRole("button", { name: "개발 작업공간", exact: true }),
    ).toHaveCount(0);
    await page.locator("iframe").scrollIntoViewIfNeeded();
    await frame
      .getByRole("heading", { name: "작업의 흐름을 한눈에" })
      .screenshot({ path: testInfo.outputPath("preview-heading.png") });
    await page.screenshot({
      path: testInfo.outputPath("workbench-preview.png"),
      fullPage: true,
    });
    await frame
      .getByRole("heading", { name: "작업의 흐름을 한눈에" })
      .evaluate((element) => {
        element.tabIndex = 0;
        element.focus();
      });
    await pressWorkbenchKey(app, "n");
    await expect(
      page.getByRole("region", { name: "개발 작업공간", exact: true }),
    ).toHaveAttribute("data-drawer-state", "folded");
    await pressWorkbenchKey(app, "n");
    await expect(
      page.getByRole("region", { name: "개발 작업공간", exact: true }),
    ).toHaveAttribute("data-drawer-state", "open");
    await page.getByRole("button", { name: "세션 종료", exact: true }).click();
    await expect(page.locator(".dev-session-tabs")).toContainText("종료");
    await expect
      .poll(async () => {
        try {
          await fetch("http://127.0.0.1:4183");
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("installed Codex reaches an interactive screen without submitting work", async () => {
  test.skip(
    process.env.REELS_CLI_QA !== "1",
    "Explicit local CLI smoke check only",
  );
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    for (const kind of ["codex"] as const) {
      const session = await page.evaluate(
        async (kind) => window.reels!.workbench!.start({ kind }),
        kind,
      );
      await expect
        .poll(
          async () => {
            const snapshot = await page.evaluate(
              async (id) => window.reels!.workbench!.snapshot(id),
              session.id,
            );
            expect(snapshot.session.state).toBe("running");
            expect(snapshot.output).not.toMatch(
              /command not found|unknown option|bad option/,
            );
            return /codex|trust|sign.in|theme/i.test(snapshot.output);
          },
          { timeout: 20000 },
        )
        .toBe(true);
      await page.evaluate(
        async (id) => window.reels!.workbench!.stop(id),
        session.id,
      );
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await window.reels!.workbench!.snapshot(id)).session.state,
            session.id,
          ),
        )
        .toBe("exited");
    }
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("quitting the app stops its preview process", async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: "1" });
    const page = await app.firstWindow();
    const session = await page.evaluate(async () =>
      window.reels!.workbench!.start({ kind: "preview" }),
    );
    await expect
      .poll(async () => {
        try {
          const response = await fetch("http://127.0.0.1:4183", {
            signal: AbortSignal.timeout(1000),
          });
          return response.ok;
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(
      await page.evaluate(
        async (id) =>
          (await window.reels!.workbench!.snapshot(id)).session.state,
        session.id,
      ),
    ).toBe("running");
    await closeApp(app);
    app = undefined;
    await expect
      .poll(async () => {
        try {
          await fetch("http://127.0.0.1:4183");
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
