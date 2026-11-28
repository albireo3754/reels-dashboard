import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lVwAAAAASUVORK5CYII=";
// Replace only the synthetic QA process's Edits helper spawn. All other code paths,
// including Dashboard preload, IPC validation, receipts and session leases, stay real.
const fakeHelper = `
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "fake-state.json")));
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", async () => {
  const req = JSON.parse(raw);
  const reply = envelope => console.log(JSON.stringify({protocol: 1, id: req.id, ...envelope}));
  const fail = code => { reply({ok: false, error: {code}}); process.exitCode = 1; };
  const check = () => {
    if (config.lock === "locked") return "FINAL_SHARE_LOCKED";
    try {
      const lease = JSON.parse(fs.readFileSync(req.args.lease));
      if (lease.parentPid !== process.ppid || lease.expiresAt <= Date.now() ||
          (config.lock === "unknown" && !lease.observedUnlock)) return "FINAL_SHARE_SESSION_UNKNOWN";
    } catch { return "FINAL_SHARE_SESSION_UNKNOWN"; }
  };
  let fingerprint = (config.target || "a").repeat(64);
  const windowKey = (config.window || "b").repeat(64);
  const success = {state: "confirmed", url: "https://www.instagram.com/p/MockPost9/"};
  if (req.operation === "synthetic-probe") return reply({ok: true, result: "synthetic-edits-only"});
  if (req.operation === "status") {
    fs.appendFileSync(path.join(__dirname, "fake-status"), "status\\n");
    return reply({ok: true, result: {trusted: Boolean(config.accessibility),
      screenCaptureAllowed: Boolean(config.recording), installed: true, running: true,
      screenLocked: config.lock === "unknown" ? null : config.lock === "locked"}});
  }
  if (req.operation === "final-share-recheck") {
    const blocked = check();
    if (blocked) return fail(blocked);
    return reply({ok: true, result: req.args.windowKey === windowKey && config.laterSuccess ? success : {state: "pending"}});
  }
  if (req.operation === "final-share-preview" || req.operation === "final-share-caption") {
    const blocked = check();
    if (blocked) return fail(blocked);
    if (!config.accessibility && config.diagnose) return fail("FINAL_SHARE_PERMISSION");
    if (req.operation === "final-share-caption") {
      if (req.args.fingerprint !== fingerprint) return fail("FINAL_SHARE_CHANGED");
      config.caption = req.args.caption;
      config.target = config.target === "d" ? "e" : "d";
      fingerprint = config.target.repeat(64);
      fs.writeFileSync(path.join(__dirname, "fake-state.json"), JSON.stringify(config));
    }
    return reply({ok: true, result: {fingerprint, windowKey,
      image: "data:image/png;base64,${screenshot}", account: "@mock_reels", caption: config.caption ?? "Fixture caption"}});
  }
  if (req.operation !== "final-share-confirm") throw new Error("Expected a final-share operation");
  if (config.delay) await new Promise(resolve => setTimeout(resolve, config.delay));
  const blocked = check();
  if (blocked) return fail(blocked);
  if (req.args.fingerprint !== fingerprint) return fail("FINAL_SHARE_CHANGED");
  fs.appendFileSync(path.join(__dirname, "fake-clicks"), "Share\\n");
  if (config.outcome === "lost") return process.exit(9);
  return reply({ok: true, result: success});
});
`;

type FakeState = { diagnose?: boolean; accessibility?: boolean; recording?: boolean; caption?: string; lock?: "unlocked" | "locked" | "unknown"; target?: string; outcome?: "lost"; delay?: number; window?: string; laterSuccess?: boolean };
const setFake = (profile: string, state: FakeState) =>
  writeFile(path.join(profile, "fake-state.json"), JSON.stringify(state));
const clicks = (profile: string) =>
  readFile(path.join(profile, "fake-clicks"), "utf8").catch(() => "");
async function seed(profile: string, captionDocument?: string) {
  const row = {
    stage: "editing", date: "2026-11-23", nextAction: "", publicURL: "", shared: false,
    publications: [{ channel: "instagram", status: "planned", url: "" }],
  };
  await writeFile(path.join(profile, "dashboard.json"), JSON.stringify({
    schemaVersion: 1, updatedAt: "2026-11-23T00:00:00.000Z",
    projects: [{ ...row, id: "share-a", title: "Mock reel A", resources: captionDocument ? [{ role: "document", label: "문안", path: captionDocument }] : [] }, { ...row, id: "share-b", title: "Mock reel B" }],
  }));
  await writeFile(path.join(profile, "fake-edits.cjs"), fakeHelper);
}
async function launchMock(profile: string) {
  const helper = path.join(profile, "fake-edits.cjs");
  await Promise.all([access(helper), access(path.join(profile, "fake-state.json"))]);
  const app = await launchApp(profile, false);
  try {
    await app.evaluate(async ({ app: host }, { node, helper }) => {
      const childProcess = process.getBuiltinModule("child_process");
      const fs = process.getBuiltinModule("fs");
      const path = process.getBuiltinModule("path");
      if (!childProcess || !fs || !path) throw new Error("Missing modules for the fake Edits helper");
      const expected = host.isPackaged
        ? path.join(process.resourcesPath, "native", "editsax")
        : path.join(host.getAppPath(), "native", "editsax", ".build", "editsax");
      const checkFixture = () => {
        fs.accessSync(node, fs.constants.X_OK);
        fs.accessSync(helper, fs.constants.R_OK);
      };
      checkFixture();
      const intercept = new Proxy(childProcess.spawn, {
        apply(spawn, receiver, args) {
          const executable: unknown = args[0];
          if (typeof executable !== "string" || path.basename(executable) !== "editsax") {
            return Reflect.apply(spawn, receiver, args);
          }
          if (path.normalize(executable) !== expected) throw new Error("Unexpected Edits helper path in synthetic QA");
          checkFixture();
          return Reflect.apply(spawn, receiver, [node, [helper], args[2]]);
        },
      });
      childProcess.spawn = intercept;
      if (childProcess.spawn !== intercept) throw new Error("Unable to intercept the real Edits helper");
      await new Promise<void>((resolve, reject) => {
        const child = childProcess.spawn(expected, [], { stdio: "pipe" });
        const deadline = setTimeout(() => {
          child.kill();
          reject(new Error("Synthetic Edits helper did not respond"));
        }, 3000);
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(deadline);
          try {
            if (code !== 0 || JSON.parse(stdout).result !== "synthetic-edits-only")
              throw new Error("Synthetic Edits helper probe failed");
            resolve();
          } catch (error) { reject(error); }
        });
        child.stdin.on("error", reject);
        child.stdin.end(JSON.stringify({ id: "synthetic-edits-probe", operation: "synthetic-probe" }));
      });
    }, { node: process.execPath, helper });
    return app;
  } catch (error) {
    await closeApp(app);
    throw error;
  }
}
async function sendOSFixture(app: ElectronApplication, event: "lock-screen" | "unlock-screen" | "suspend" | "resume") {
  await app.evaluate(({ powerMonitor }, name) => { powerMonitor.emit(name); }, event);
}
async function openShare(page: Page, card = "Mock reel A") {
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: card, exact: true }) })
    .getByRole("button", { name: "인스타그램 최종 게시" }).click();
  return page.getByRole("dialog", { name: "인스타그램 최종 게시" });
}

async function approveFixture(modal: Locator) {
  await expect(modal.getByText("@mock_reels", { exact: true })).toBeVisible();
  await modal.getByRole("checkbox").check();
}

test.describe("Edits final share", () => {
  test.skip(process.platform !== "darwin", "macOS Edits helper");

  test("diagnoses permissions and retried preview never Share", async () => {
    const profile = await makeProfile();
    let app: ElectronApplication | undefined;
    try {
      await seed(profile);
      await setFake(profile, { lock: "unlocked", diagnose: true });
      app = await launchMock(profile);
      const page = await app.firstWindow();
      const modal = await openShare(page);
      await expect(modal.getByRole("status")).toContainText("손쉬운 사용 및 화면 기록");
      await modal.getByRole("button", { name: "Edits 권한 확인" }).click();
      await expect(modal.getByText("손쉬운 사용: 허용 필요", { exact: true })).toBeVisible();
      await expect(modal.getByText("화면 기록: 허용 필요", { exact: true })).toBeVisible();
      await expect(modal.getByRole("button", { name: "손쉬운 사용 설정 열기" })).toBeVisible();
      await expect(modal.getByRole("button", { name: "화면 기록 설정 열기" })).toBeVisible();

      await setFake(profile, { lock: "locked", diagnose: true, accessibility: true });
      await modal.getByRole("button", { name: "Edits 권한 확인" }).click();
      await expect(modal.getByText("화면 잠금: 잠김", { exact: true })).toBeVisible();
      await expect(modal.getByRole("button", { name: "화면 기록 설정 열기" })).toHaveCount(0);
      await expect(modal.getByRole("button", { name: "지금 공개 게시" })).toHaveCount(0);

      await setFake(profile, { lock: "unlocked", diagnose: true, accessibility: true, recording: true });
      await modal.getByRole("button", { name: "Edits 권한 확인" }).click();
      await expect(modal.getByText("손쉬운 사용: 허용됨", { exact: true })).toBeVisible();
      await expect(modal.getByText("화면 기록: 허용됨", { exact: true })).toBeVisible();
      await modal.getByRole("button", { name: "공유 창 다시 확인" }).click();
      await expect(modal.getByText("@mock_reels", { exact: true })).toBeVisible();
      await expect(modal.getByRole("button", { name: "지금 공개 게시" })).toBeDisabled();
      expect(await readFile(path.join(profile, "fake-status"), "utf8")).toBe("status\nstatus\nstatus\n");
      expect(await clicks(profile)).toBe("");
    } finally {
      if (app) await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("edit the caption, verify readback and require a separate Share approval", async () => {
    const profile = await makeProfile();
    let app: ElectronApplication | undefined;
    try {
      const doc = path.join(profile, "caption.md");
      const copy = "물빛이에요🩵\n\n#여행";
      await writeFile(doc, "---\ncontent_id: a\n---\n### 캡션 — 초안 v2\n```text\n" + copy + "\n```");
      await seed(profile, doc);
      // Published-copy documents are identified by their content: ID.
      const file = path.join(profile, "dashboard.json");
      const board = JSON.parse(await readFile(file, "utf8"));
      board.projects[0].id = "content:a";
      await writeFile(file, JSON.stringify(board));
      await setFake(profile, { lock: "unlocked", caption: "Edits에 먼저 작성한 문구" });
      app = await launchMock(profile);
      const page = await app.firstWindow();
      const modal = await openShare(page);
      const field = modal.getByRole("textbox", { name: "Instagram 캡션" });
      const apply = modal.getByRole("button", { name: "Edits에 캡션 반영" });
      const submit = modal.getByRole("button", { name: "지금 공개 게시" });
      await expect(field).toHaveValue("Edits에 먼저 작성한 문구");
      await modal.getByRole("button", { name: "카드 문안 불러오기" }).click();
      await expect(field).toHaveValue(copy);
      await expect(submit).toBeDisabled();
      await field.fill("가".repeat(2201));
      await expect(apply).toBeDisabled();
      await field.fill(copy);
      await apply.click();
      await expect(modal.getByRole("status")).toContainText("반영된 캡션");
      await expect(apply).toBeDisabled();
      await expect(submit).toBeDisabled();
      expect(await clicks(profile)).toBe("");
      expect(JSON.parse(await readFile(path.join(profile, "fake-state.json"), "utf8")).caption).toBe(copy);
      await modal.getByRole("button", { name: "닫기" }).click();
      await openShare(page);
      await expect(field).toHaveValue(copy);
      await approveFixture(modal);
      await submit.click();
      await expect(modal.getByRole("link", { name: /Instagram 게시물/ })).toBeVisible();
      expect(await clicks(profile)).toBe("Share\n");
    } finally {
      if (app) await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("fresh approval, real main event lease, changed target, lock and explicit success", async () => {
    const profile = await makeProfile();
    let app: ElectronApplication | undefined;
    try {
      await seed(profile);
      await setFake(profile, { lock: "unknown" });
      app = await launchMock(profile);
      const page = await app.firstWindow();
      const modal = await openShare(page);
      const retry = modal.getByRole("button", { name: "공유 창 다시 확인" });
      const submit = modal.getByRole("button", { name: "지금 공개 게시" });
      await expect(modal.getByRole("status")).toContainText("잠금 해제를 확인하지 못했어요");
      await expect(submit).toHaveCount(0);
      await sendOSFixture(app, "unlock-screen");
      await retry.click();
      await expect(modal.getByRole("img")).toBeVisible();
      await expect(modal.getByText("@mock_reels")).toBeVisible();
      await expect(modal.getByRole("textbox", { name: "Instagram 캡션" })).toHaveValue("Fixture caption");
      await expect(submit).toBeDisabled();
      await approveFixture(modal);
      await setFake(profile, { lock: "unknown", target: "c" });
      await submit.click();
      await expect(modal.getByRole("status")).toContainText("Edits 창이 바뀌었거나");
      expect(await clicks(profile)).toBe("");

      await retry.click();
      await approveFixture(modal);
      await setFake(profile, { lock: "locked", target: "c" });
      await submit.click();
      await expect(modal.getByRole("status")).toContainText("Mac을 직접 잠금 해제한 뒤");
      await setFake(profile, { lock: "unknown", target: "c" });
      await sendOSFixture(app, "lock-screen");
      await retry.click();
      await expect(modal.getByRole("status")).toContainText("Mac을 직접 잠금 해제한 뒤");
      await sendOSFixture(app, "unlock-screen");
      await retry.click();
      await approveFixture(modal);
      await sendOSFixture(app, "suspend");
      await sendOSFixture(app, "resume");
      await submit.click();
      await expect(modal.getByRole("status")).toContainText("새 미리보기");
      expect(await clicks(profile)).toBe("");

      await sendOSFixture(app, "unlock-screen");
      await retry.click();
      await approveFixture(modal);
      await submit.click();
      await expect(modal.getByRole("link", { name: "Instagram 게시물 보기 ↗" }))
        .toHaveAttribute("href", "https://www.instagram.com/p/MockPost9/");
      expect(await clicks(profile)).toBe("Share\n");
      expect((await page.evaluate(() => window.reels!.loadDashboard())).projects[0].publications?.[0].status).toBe("planned");

      await modal.getByRole("button", { name: "닫기" }).click();
      await expect((await openShare(page)).getByRole("status")).toContainText("게시 성공");
      expect(await clicks(profile)).toBe("Share\n");
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("cancel before dispatch and block a lost response across cards and restarts", async () => {
    const profile = await makeProfile();
    let app: ElectronApplication | undefined;
    try {
      await seed(profile);
      await setFake(profile, { lock: "unlocked", delay: 1500 });
      app = await launchMock(profile);
      let page = await app.firstWindow();
      const modal = await openShare(page);
      const submit = modal.getByRole("button", { name: "지금 공개 게시" });
      await approveFixture(modal);
      await submit.click();
      await modal.getByRole("button", { name: "요청 중단" }).click();
      await expect(modal.getByRole("status")).toContainText("요청을 중단했어요");
      expect(await clicks(profile)).toBe("");

      await modal.getByRole("button", { name: "공유 창 다시 확인" }).click();
      await approveFixture(modal);
      await setFake(profile, { lock: "unlocked", outcome: "lost" });
      await submit.click();
      await expect(modal.getByRole("status")).toContainText("게시 결과 확인 대기");
      await expect(submit).toHaveCount(0);
      await modal.getByRole("button", { name: "닫기" }).click();
      const other = await openShare(page, "Mock reel B");
      await expect(other.getByRole("status")).toContainText("이 Edits 창에는 이미 게시 요청 기록");
      expect(await clicks(profile)).toBe("Share\n");

      await closeApp(app);
      app = undefined;
      app = await launchMock(profile);
      page = await app.firstWindow();
      const restored = await openShare(page);
      await expect(restored.getByRole("status")).toContainText("게시 결과 확인 대기");
      await expect(restored.getByRole("button", { name: "지금 공개 게시" })).toHaveCount(0);
      const recheck = restored.getByRole("button", { name: "게시 결과 다시 확인" });
      await recheck.click();
      await expect(restored.getByRole("status")).toContainText("게시 결과 확인 대기");
      await setFake(profile, { lock: "unknown", laterSuccess: true });
      await recheck.click();
      await expect(restored.getByRole("status")).toContainText("공식 Codex Computer Use");
      await setFake(profile, { lock: "unlocked", window: "c", laterSuccess: true });
      await recheck.click();
      await expect(restored.getByRole("status")).toContainText("게시 결과 확인 대기");
      await setFake(profile, { lock: "unlocked", laterSuccess: true });
      await recheck.click();
      await expect(restored.getByRole("link", { name: "Instagram 게시물 보기 ↗" }))
        .toHaveAttribute("href", "https://www.instagram.com/p/MockPost9/");
      expect(await clicks(profile)).toBe("Share\n");
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });
});
