import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

function collect(
  root: string,
  source = "scheduled",
  extra: Record<string, string> = {},
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.resolve("tests/fixtures/instagram-headless.mjs"),
      path.resolve("dist-cli/reels.mjs"),
      "collect-instagram-insights",
      "--source",
      source,
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        REELS_USER_DATA: root,
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; data: any; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        try {
          resolve({ code, data: JSON.parse(stdout), stderr });
        } catch (e) {
          reject(e);
        }
      });
    },
  );
  return { child, done };
}
async function seed(profile: string) {
  const file = path.join(profile, "test-credential");
  await writeFile(file, "synthetic-private-token-" + "x".repeat(60), {
    mode: 0o600,
  });
  await writeFile(
    path.join(profile, "instagram-connection.json"),
    JSON.stringify({
      username: "creator_demo",
      login: "unified",
      tokenFile: file,
      topics: {},
    }),
    { mode: 0o600 },
  );
}
test("built CLI collects without Electron, keeps manual/scheduled history and exits nonzero once on each failure", async () => {
  const root = await makeProfile();
  try {
    await seed(root);
    const first = await collect(root).done;
    expect(first.code).toBe(0);
    expect(first.data.data.source).toBe("scheduled");
    expect(first.data.data.tokenHealth.status).toBe("unknown");
    expect(
      await access(path.join(root, "agent", "connection.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const second = await collect(root, "manual").done;
    expect(second.code).toBe(0);
    expect(second.data.data.snapshotId).not.toBe(first.data.data.snapshotId);
    const history = await readFile(
      path.join(root, "instagram-history.json"),
      "utf8",
    );
    expect(JSON.parse(history).map((h: any) => h.source)).toEqual([
      "manual",
      "scheduled",
    ]);
    const previous = await readFile(
      path.join(
        root,
        "instagram-snapshots",
        first.data.data.snapshotId + ".json",
      ),
      "utf8",
    );
    for (const [failure, code] of [
      ["190", "INSTAGRAM_AUTH"],
      ["200", "INSTAGRAM_PERMISSION"],
      ["4", "INSTAGRAM_RATE_LIMIT"],
      ["network", "INSTAGRAM_NETWORK"],
    ]) {
      await writeFile(path.join(root, "test-api-calls"), "");
      const failed = await collect(root, "scheduled", {
        INSTAGRAM_TEST_FAILURE: failure,
      }).done;
      expect(failed.code).toBe(4);
      expect(failed.data.error.code).toBe(code);
      expect(failed.data.error.retry).toBe("no");
      expect(JSON.stringify(failed)).not.toContain("access_token");
      expect(JSON.stringify(failed)).not.toContain("synthetic-private-token");
      expect(
        (await readFile(path.join(root, "test-api-calls"), "utf8"))
          .trim()
          .split("\n"),
      ).toHaveLength(1);
      expect(
        await readFile(path.join(root, "instagram-history.json"), "utf8"),
      ).toBe(history);
      expect(
        await readFile(
          path.join(
            root,
            "instagram-snapshots",
            first.data.data.snapshotId + ".json",
          ),
          "utf8",
        ),
      ).toBe(previous);
    }
  } finally {
    await cleanProfile(root);
  }
});
test("background Electron and CLI share a process lock, refresh the open view, and work after app shutdown", async () => {
  test.setTimeout(120000);
  const root = await makeProfile();
  await seed(root);
  const app = await launchApp(root, false);
  let child: ReturnType<typeof collect> | undefined;
  try {
    const page = await app.firstWindow();
    await app.evaluate(() => {
      (globalThis as any).instagramTestCalls = 0;
      globalThis.fetch = async () => {
        (globalThis as any).instagramTestCalls++;
        throw new Error("Unexpected app API call");
      };
    });
    await page
      .getByRole("navigation", { name: "주요 메뉴" })
      .getByRole("button", { name: "Instagram 인사이트", exact: true })
      .click();
    child = collect(root, "scheduled", { INSTAGRAM_TEST_GATE: "1" });
    await expect
      .poll(() =>
        access(path.join(root, "test-api-ready")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    expect(
      (await page.evaluate(() => window.reels!.instagramInsights!.get())).busy,
    ).toBe(true);
    await page.evaluate(() => window.reels!.instagramInsights!.refresh());
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.reels!.instagramInsights!.get()).lastError,
        ),
      )
      .toContain("INSTAGRAM_BUSY");
    expect(
      await app.evaluate(() => (globalThis as any).instagramTestCalls),
    ).toBe(0);
    await writeFile(path.join(root, "test-api-release"), "release");
    const completed = await child.done;
    expect(completed.code).toBe(0);
    await expect(
      page.getByRole("table").getByText("250", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(/에 수집 · KST · 예약/)).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The app owns the lock next; the separate CLI must fail before any API request.
    await app.evaluate(() => {
      globalThis.fetch = async () =>
        new Promise((resolve) => {
          (globalThis as any).instagramRelease = () =>
            resolve(Response.json({ error: { code: 190 } }, { status: 401 }));
        });
    });
    await page.evaluate(() => window.reels!.instagramInsights!.refresh());
    await expect
      .poll(() =>
        app.evaluate(() => typeof (globalThis as any).instagramRelease),
      )
      .toBe("function");
    const busy = await collect(root).done;
    expect(busy.code).toBe(6);
    expect(busy.data.error.code).toBe("INSTAGRAM_BUSY");
    await app.evaluate(() => (globalThis as any).instagramRelease());
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.reels!.instagramInsights!.get()).busy,
        ),
      )
      .toBe(false);
    await closeApp(app);
    const offline = await collect(root, "manual").done;
    expect(offline.code).toBe(0);
    expect(
      JSON.parse(
        await readFile(path.join(root, "instagram-history.json"), "utf8"),
      ),
    ).toHaveLength(2);
  } finally {
    child?.child.kill();
    await closeApp(app);
    await cleanProfile(root);
  }
});

test("interrupting a headless collection releases the shared lock and preserves history", async () => {
  const root = await makeProfile();
  let running: ReturnType<typeof collect> | undefined;
  try {
    await seed(root);
    running = collect(root, "scheduled", { INSTAGRAM_TEST_GATE: "1" });
    await expect
      .poll(() =>
        access(path.join(root, "test-api-ready")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    running.child.kill("SIGTERM");
    const stopped = await running.done;
    expect(stopped.code).toBe(143);
    expect(
      await access(path.join(root, "instagram-collection.lock")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await access(path.join(root, "instagram-history.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    running?.child.kill();
    await cleanProfile(root);
  }
});
