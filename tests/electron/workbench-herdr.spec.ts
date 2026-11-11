import { test, expect, type Page } from "@playwright/test";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication } from "@playwright/test";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

// herdr session-backend scenarios. Every test runs against its own isolated
// `reels-qa-<random>` herdr session (never the user's default session) and only
// that session is stopped and deleted afterwards. Assertions go through the
// desktop bridge (window.reels.workbench) and terminal output, not UI selectors.

const execFileAsync = promisify(execFile);
const PREFIX = "reels-dashboard:";
const QA_SESSION = /^reels-qa-[A-Za-z0-9._-]+$/;
/** A login zsh (oh-my-zsh, ssh-add) was measured reading its first input after ~19 s. */
const SHELL_READY_MS = 60_000;
const SHELL_OUTPUT_MS = 20_000;
/** An isolated session left by an interrupted run: nothing in its directory changed for this long. */
const STALE_SESSION_MS = 15 * 60_000;
/** `reels-dashboard:<kind>:<uuid>:<first 12 hex of sha256(realpath of the source folder)>` */
const labelFor = (kind: string, id: string, workspace: string) =>
  `${PREFIX}${kind}:${id}:${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
const herdrEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => !key.startsWith("HERDR_") && typeof value === "string",
  ),
) as NodeJS.ProcessEnv;

let herdrInstalled = false;
try {
  execFileSync("herdr", ["--version"], { env: herdrEnv, stdio: "ignore" });
  herdrInstalled = true;
} catch {
  herdrInstalled = false;
}

async function herdr(session: string | null, ...args: string[]) {
  const full = session ? ["--session", session, ...args] : args;
  const { stdout } = await execFileAsync("herdr", full, {
    env: herdrEnv,
    timeout: 20_000,
  });
  return stdout.trim();
}
type Workspace = { workspace_id: string; label?: string };
async function workspaces(session: string): Promise<Workspace[]> {
  const parsed = JSON.parse(await herdr(session, "workspace", "list"));
  return parsed.result?.workspaces ?? [];
}
async function terminalIdOf(session: string, workspaceId: string) {
  const parsed = JSON.parse(
    await herdr(session, "pane", "list", "--workspace", workspaceId),
  );
  return parsed.result.panes[0].terminal_id as string;
}
type SessionInfo = { name: string; running: boolean; session_dir?: string };
/** Throws unless herdr answered with a session list, so an empty result is never a failed query. */
async function sessionList(): Promise<SessionInfo[]> {
  const parsed = JSON.parse(await herdr(null, "session", "list", "--json"));
  if (
    !Array.isArray(parsed?.sessions) ||
    !parsed.sessions.every((s: SessionInfo) => typeof s?.name === "string")
  )
    throw new Error(`unexpected herdr session list: ${JSON.stringify(parsed).slice(0, 300)}`);
  return parsed.sessions;
}
/** The workspace list, or [] only when the isolated server is not running (any other failure throws). */
async function workspacesOrNone(session: string): Promise<Workspace[]> {
  try {
    return await workspaces(session);
  } catch (error) {
    if (/"code":"server_not_running"/.test(String((error as { stderr?: string }).stderr)))
      return [];
    throw error;
  }
}
/** Stops and deletes one isolated QA session; fails loudly if it stays listed. */
async function removeSession(name: string) {
  if (!QA_SESSION.test(name)) throw new Error(`refusing to remove non-QA session ${name}`);
  const found = (await sessionList()).find((s) => s.name === name);
  if (!found) return;
  if (found.running) {
    await herdr(null, "session", "stop", name);
    await expect
      .poll(async () => (await sessionList()).find((s) => s.name === name)?.running ?? false, {
        timeout: 10_000,
      })
      .toBe(false);
  }
  await herdr(null, "session", "delete", name);
  expect((await sessionList()).map((s) => s.name)).not.toContain(name);
}
/** Newest modification time inside a session directory (its logs and socket). */
async function lastActivity(dir: string) {
  let newest = (await stat(dir)).mtimeMs;
  for (const entry of await readdir(dir))
    newest = Math.max(newest, (await stat(join(dir, entry)).catch(() => null))?.mtimeMs ?? 0);
  return newest;
}

const sessions: string[] = [];
const externalClients: ChildProcess[] = [];
function killGroup(child: ChildProcess) {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
function newSession() {
  const name = `reels-qa-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  sessions.push(name);
  return name;
}
test.afterEach(async () => {
  for (const child of externalClients.splice(0)) killGroup(child);
  const failures: string[] = [];
  for (const name of sessions.splice(0)) {
    // Only the isolated session this test created; never "default".
    try {
      await removeSession(name);
    } catch (error) {
      failures.push(`${name}: ${String(error).slice(0, 300)}`);
    }
  }
  if (failures.length)
    throw new Error(`isolated herdr session cleanup failed:\n${failures.join("\n")}`);
});

// A run that was interrupted (SIGINT, crash) never reached afterEach. Sweep only
// `reels-qa-*` sessions whose directory has been idle long enough that no other
// run can be using them; the user's sessions are never candidates.
test.beforeAll(async () => {
  if (!herdrInstalled) return;
  for (const s of await sessionList()) {
    if (!QA_SESSION.test(s.name) || !s.session_dir) continue;
    const idle = Date.now() - (await lastActivity(s.session_dir).catch(() => Date.now()));
    if (idle < STALE_SESSION_MS) continue;
    console.warn(`removing stale herdr QA session ${s.name} (idle ${Math.round(idle / 60_000)} min)`);
    await removeSession(s.name);
  }
});

const bridgeState = (page: Page) =>
  page.evaluate(() => window.reels!.workbench!.state());
const output = (page: Page, id: string) =>
  page.evaluate(
    async (id) => (await window.reels!.workbench!.snapshot(id)).output,
    id,
  );
const write = (page: Page, id: string, text: string) =>
  page.evaluate(
    async ({ id, text }) => window.reels!.workbench!.write(id, text),
    { id, text },
  );
/**
 * Waits until the shell has executed a probe line (the echoed input holds `$((40+2))`, only the
 * result holds `42`). The probe is re-sent in case a startup script discarded early input.
 */
async function waitForShell(page: Page, id: string) {
  const mark = `ready${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + SHELL_READY_MS;
  let resendAt = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= resendAt) {
      await write(page, id, ` echo ${mark}-$((40+2))\r`);
      resendAt = Date.now() + 15_000;
    }
    if ((await output(page, id)).includes(`${mark}-42`)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `shell ${id} did not run input within ${SHELL_READY_MS} ms; tail: ${JSON.stringify((await output(page, id)).slice(-400))}`,
  );
}

async function makeCheckout(profile: string) {
  const workspace = join(profile, "source checkout");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "reels-dashboard",
      scripts: {
        dev: "node dev.js",
        typecheck: "echo typecheck-ok",
      },
    }),
  );
  // Stands in for the Vite preview server: stays alive until stopped.
  await writeFile(join(workspace, "dev.js"), "setTimeout(() => {}, 120000);\n");
  return realpath(workspace);
}

async function launch(
  profile: string,
  session: string,
  workspace: string,
  backend: "direct" | "herdr" | undefined = "herdr",
) {
  const app = await launchApp(profile, true, {
    REELS_DEV_MODE: "1",
    REELS_TERMINAL_BACKEND: backend,
    REELS_HERDR_SESSION: session,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, workspace);
  return { app, page };
}
async function connect(page: Page) {
  await page.evaluate(() => window.reels!.workbench!.chooseWorkspace());
}

test.describe("herdr session backend", () => {
  test.skip(!herdrInstalled, "herdr is not installed");
  // App launches plus a login shell that can take ~20 s to read input.
  test.setTimeout(180_000);

  test("1. shell runs in a herdr workspace and shows command output", async () => {
    const profile = await makeProfile();
    const session = newSession();
    let app: ElectronApplication | undefined;
    try {
      const workspace = await makeCheckout(profile);
      const launched = await launch(profile, session, workspace);
      app = launched.app;
      const { page } = launched;
      await connect(page);
      const initial = await bridgeState(page);
      expect(initial.terminalBackend).toMatchObject({
        selected: "herdr",
        effective: "herdr",
        herdrInstalled: true,
        session,
        forcedByEnv: true,
      });
      const terminal = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "shell" }),
      );
      expect(terminal.backend).toBe("herdr");
      expect(terminal.state).toBe("running");
      expect(initial.terminalBackend.checking).toBe(false);
      await waitForShell(page, terminal.id);
      await write(page, terminal.id, "echo $((20+22))-HERDR_OK\r");
      await expect
        .poll(() => output(page, terminal.id), { timeout: SHELL_OUTPUT_MS })
        .toContain("42-HERDR_OK");
      const labels = (await workspaces(session)).map((w) => w.label ?? "");
      expect(labels).toContain(labelFor("shell", terminal.id, workspace));
      expect(
        (await bridgeState(page)).sessions.find((s) => s.id === terminal.id),
      ).toMatchObject({ backend: "herdr", state: "running" });
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("2. shell survives an app restart and is restored with its variables, even after cd", async () => {
    const profile = await makeProfile();
    const session = newSession();
    const mark = `mark${randomUUID().slice(0, 6)}`;
    let app: ElectronApplication | undefined;
    try {
      const workspace = await makeCheckout(profile);
      const first = await launch(profile, session, workspace);
      app = first.app;
      await connect(first.page);
      const terminal = await first.page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "shell" }),
      );
      await waitForShell(first.page, terminal.id);
      // Leaving the source folder must not stop the restore (ownership is the label's source tag).
      await write(
        first.page,
        terminal.id,
        `export REELS_QA_MARK=${mark}; cd /; echo set-$REELS_QA_MARK-$PWD\r`,
      );
      await expect
        .poll(() => output(first.page, terminal.id), { timeout: SHELL_OUTPUT_MS })
        .toContain(`set-${mark}-/`);
      await closeApp(app);
      app = undefined;

      // Quitting the app only drops the attach client; the workspace remains.
      const label = labelFor("shell", terminal.id, workspace);
      expect((await workspaces(session)).map((w) => w.label)).toContain(label);

      const second = await launch(profile, session, workspace);
      app = second.app;
      await expect
        .poll(async () => (await bridgeState(second.page)).sessions.length)
        .toBe(1);
      const restored = (await bridgeState(second.page)).sessions[0];
      expect(restored).toMatchObject({
        id: terminal.id,
        kind: "shell",
        backend: "herdr",
        state: "running",
        restored: true,
      });
      await waitForShell(second.page, restored.id);
      await write(second.page, restored.id, "echo again-$REELS_QA_MARK\r");
      await expect
        .poll(() => output(second.page, restored.id), { timeout: SHELL_OUTPUT_MS })
        .toContain(`again-${mark}`);
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("3. closing a tab removes only its own workspace", async () => {
    const profile = await makeProfile();
    const session = newSession();
    let app: ElectronApplication | undefined;
    try {
      const workspace = await makeCheckout(profile);
      const launched = await launch(profile, session, workspace);
      app = launched.app;
      const { page } = launched;
      await connect(page);
      const terminal = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "shell" }),
      );
      // The app started the isolated server; add a workspace the app must not touch.
      await herdr(
        session,
        "workspace",
        "create",
        "--cwd",
        workspace,
        "--label",
        "qa-foreign-workspace",
        "--no-focus",
      );
      const label = labelFor("shell", terminal.id, workspace);
      expect((await workspaces(session)).map((w) => w.label)).toEqual(
        expect.arrayContaining([label, "qa-foreign-workspace"]),
      );
      await page.evaluate(
        async (id) => window.reels!.workbench!.close(id),
        terminal.id,
      );
      await expect
        .poll(async () => (await workspaces(session)).map((w) => w.label))
        .not.toContain(label);
      expect((await workspaces(session)).map((w) => w.label)).toContain(
        "qa-foreign-workspace",
      );
      expect((await bridgeState(page)).sessions).toHaveLength(0);
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("4. preview and checks stay direct while herdr is selected", async () => {
    const profile = await makeProfile();
    const session = newSession();
    let app: ElectronApplication | undefined;
    try {
      const workspace = await makeCheckout(profile);
      const launched = await launch(profile, session, workspace);
      app = launched.app;
      const { page } = launched;
      await connect(page);
      expect((await bridgeState(page)).terminalBackend.effective).toBe("herdr");
      // The synthetic checkout's dev script and typecheck are trivial, so these
      // run quickly; checks fails at the missing architecture script, which is
      // irrelevant here. Only the backend field matters.
      const preview = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "preview" }),
      );
      expect(preview.backend).toBe("direct");
      await page.evaluate(
        async (id) => window.reels!.workbench!.stop(id),
        preview.id,
      );
      const checks = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "checks" }),
      );
      expect(checks.backend).toBe("direct");
      await expect
        .poll(
          async () =>
            (await bridgeState(page)).sessions.find((s) => s.id === checks.id)
              ?.state,
        )
        .toBe("exited");
      // Neither created a herdr workspace. The server may not be running yet, but any
      // other query failure fails the test instead of passing as "no workspaces".
      const labels = (await workspacesOrNone(session)).map((w) => w.label ?? "");
      expect(labels.filter((l) => l.startsWith(PREFIX))).toEqual([]);
      // A shell started afterwards still goes through herdr.
      const shell = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "shell" }),
      );
      expect(shell.backend).toBe("herdr");
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("5. takeover by another client detaches; reattach recovers", async () => {
    const profile = await makeProfile();
    const session = newSession();
    let app: ElectronApplication | undefined;
    try {
      const workspace = await makeCheckout(profile);
      const launched = await launch(profile, session, workspace);
      app = launched.app;
      const { page } = launched;
      await connect(page);
      const terminal = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "shell" }),
      );
      await waitForShell(page, terminal.id);
      await write(page, terminal.id, "echo before-takeover\r");
      await expect
        .poll(() => output(page, terminal.id), { timeout: SHELL_OUTPUT_MS })
        .toContain("before-takeover");
      const label = labelFor("shell", terminal.id, workspace);
      const found = (await workspaces(session)).find((w) => w.label === label)!;
      const terminalId = await terminalIdOf(session, found.workspace_id);

      // `script` gives the external client a TTY; without a window size herdr
      // rejects the attach ("zero-sized grid"), so set one first.
      // `script` also needs a pipe (not Playwright's socket) on stdin, so a
      // `sleep` feeds it; the whole process group is killed at the end.
      const external = spawn(
        "sh",
        [
          "-c",
          'sleep 120 | script -q /dev/null sh -c \'stty rows 30 cols 100; exec herdr --session "$0" terminal attach "$1" --takeover\' "$0" "$1"',
          session,
          terminalId,
        ],
        { env: herdrEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
      externalClients.push(external);
      let externalOutput = "";
      let externalExit = "alive";
      external.stdout!.on("data", (d) => (externalOutput += d));
      external.stderr!.on("data", (d) => (externalOutput += d));
      external.on("exit", (code, signal) => (externalExit = `${code}/${signal}`));
      try {
        await expect
          .poll(
            async () =>
              (await bridgeState(page)).sessions.find((s) => s.id === terminal.id)
                ?.state,
            { timeout: 20_000 },
          )
          .toBe("detached");
      } catch (error) {
        throw new Error(
          `${String(error).slice(0, 300)}\nexternal client ${externalExit}; output tail: ${JSON.stringify(externalOutput.slice(-400))}`,
        );
      }
      // The workspace is alive, and typing into a detached tab is refused.
      expect((await workspaces(session)).map((w) => w.label)).toContain(label);
      const refused = await page.evaluate(async (id) => {
        try {
          await window.reels!.workbench!.write(id, "x");
          return "accepted";
        } catch (error) {
          return String(error);
        }
      }, terminal.id);
      expect(refused).toContain("연결이 끊긴 세션");

      killGroup(external);
      const reattached = await page.evaluate(
        async (id) => window.reels!.workbench!.reattach(id),
        terminal.id,
      );
      expect(reattached.state).toBe("running");
      await write(page, terminal.id, "echo after-reattach\r");
      await expect
        .poll(() => output(page, terminal.id), { timeout: SHELL_OUTPUT_MS })
        .toContain("after-reattach");
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("8. a server restart detaches the tab; reattach restarts the server and reconnects", async () => {
    const profile = await makeProfile();
    const session = newSession();
    let app: ElectronApplication | undefined;
    try {
      const workspace = await makeCheckout(profile);
      const launched = await launch(profile, session, workspace);
      app = launched.app;
      const { page } = launched;
      await connect(page);
      const terminal = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "shell" }),
      );
      await waitForShell(page, terminal.id);
      const label = labelFor("shell", terminal.id, workspace);
      await herdr(session, "server", "stop");
      // The server is down, which is not the same as the workspace being gone.
      await expect
        .poll(
          async () =>
            (await bridgeState(page)).sessions.find((s) => s.id === terminal.id)?.state,
          { timeout: 20_000 },
        )
        .toBe("detached");
      expect(await workspacesOrNone(session)).toEqual([]);
      const reattached = await page.evaluate(
        async (id) => window.reels!.workbench!.reattach(id),
        terminal.id,
      );
      expect(reattached.state).toBe("running");
      // herdr restored the labelled workspace when the server started again.
      expect((await workspaces(session)).map((w) => w.label)).toContain(label);
      await waitForShell(page, terminal.id);
      await page.evaluate(async (id) => window.reels!.workbench!.close(id), terminal.id);
      await expect
        .poll(async () => (await workspaces(session)).map((w) => w.label))
        .not.toContain(label);
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });

  test("7. changing the backend is rejected while a session is running", async () => {
    const profile = await makeProfile();
    const session = newSession();
    let app: ElectronApplication | undefined;
    try {
      const workspace = await makeCheckout(profile);
      const launched = await launch(profile, session, workspace);
      app = launched.app;
      const { page } = launched;
      await connect(page);
      const terminal = await page.evaluate(() =>
        window.reels!.workbench!.start({ kind: "shell" }),
      );
      const result = await page.evaluate(async () => {
        try {
          await window.reels!.workbench!.setTerminalBackend("direct");
          return "accepted";
        } catch (error) {
          return String(error);
        }
      });
      expect(result).toContain("실행 중인 세션을 종료한 뒤");
      await page.evaluate(
        async (id) => window.reels!.workbench!.close(id),
        terminal.id,
      );
      // With nothing live the same request is accepted and persisted.
      const next = await page.evaluate(() =>
        window.reels!.workbench!.setTerminalBackend("direct"),
      );
      expect(next.terminalBackend.forcedByEnv).toBe(true);
      expect(
        JSON.parse(await readFile(join(profile, "workbench.json"), "utf8")),
      ).toMatchObject({ terminalBackend: "direct" });
    } finally {
      await closeApp(app);
      await cleanProfile(profile);
    }
  });
});

test("6. REELS_TERMINAL_BACKEND=direct stays direct even with herdr installed", async () => {
  test.setTimeout(180_000);
  const profile = await makeProfile();
  const session = newSession();
  let app: ElectronApplication | undefined;
  try {
    const workspace = await makeCheckout(profile);
    const launched = await launch(profile, session, workspace, "direct");
    app = launched.app;
    const { page } = launched;
    await connect(page);
    const state = await bridgeState(page);
    expect(state.terminalBackend).toMatchObject({
      selected: "direct",
      effective: "direct",
      forcedByEnv: true,
      session,
    });
    if (herdrInstalled) expect(state.terminalBackend.herdrInstalled).toBe(true);
    const terminal = await page.evaluate(() =>
      window.reels!.workbench!.start({ kind: "shell" }),
    );
    expect(terminal.backend).toBe("direct");
    await waitForShell(page, terminal.id);
    await write(page, terminal.id, "echo direct-ok\r");
    await expect
      .poll(() => output(page, terminal.id), { timeout: SHELL_OUTPUT_MS })
      .toContain("direct-ok");
    if (herdrInstalled)
      expect((await sessionList()).map((s) => s.name)).not.toContain(session);
    await page.evaluate(
      async (id) => window.reels!.workbench!.stop(id),
      terminal.id,
    );
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
