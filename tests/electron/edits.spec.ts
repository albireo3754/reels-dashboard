import { test, expect } from "@playwright/test";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

const execute = promisify(execFile);
// Status-only and diagnostics-only modes avoid editing; locked/unknown sessions never read GUI trees.
test("Edits CLI uses the background Dashboard main and its real native child", async () => {
  test.skip(process.platform !== "darwin", "macOS AX helper");
  await access("native/editsax/.build/editsax");
  const profile = await makeProfile();
  const app = await launchApp(profile, false);
  try {
    await expect
      .poll(() =>
        access(path.join(profile, "agent/connection.json")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    async function cli(...args: string[]) {
      const { stdout } = await execute(
        process.execPath,
        [path.resolve("dist-cli/reels.mjs"), ...args],
        { env: { ...process.env, REELS_USER_DATA: profile } },
      );
      return JSON.parse(stdout);
    }
    const status = await cli("edits-status");
    expect(status.ok).toBe(true);
    expect(typeof status.data.trusted).toBe("boolean");
    expect(status.data.appPath).toBe("/Applications/Edits.app");
    expect(status.data.route).toBe("Dashboard main -> native child");
    expect(status.data.parentPid).toBe(app.process().pid);
    expect([true, false, "unknown"]).toContain(status.data.screenLocked);
    await test.info().attach("edits-status.json", {
      body: JSON.stringify(status.data, null, 2),
      contentType: "application/json",
    });
    if (
      process.env.REELS_EDITS_STATUS_ONLY === "1" ||
      status.data.screenLocked !== false
    )
      return;
    if (status.data.trusted && status.data.running) {
      const tree = await cli(
        "edits-ax-tree",
        "--depth",
        "16",
        "--max-nodes",
        "4000",
      );
      await test.info().attach("edits-tree.json", {
        body: JSON.stringify(tree.data, null, 2),
        contentType: "application/json",
      });
      if (process.env.REELS_EDITS_DIAGNOSTICS_ONLY === "1") return;
      const current = await cli("edits-clip-list");
      expect(Array.isArray(current.data.clips)).toBe(true);
      await test.info().attach("edits-read-smoke.json", {
        body: JSON.stringify({
          clips: current.data.clips.length,
          metadataVerified: current.data.metadataVerified,
          complete: current.data.complete,
        }),
        contentType: "application/json",
      });
    }
    const planned = await cli(
      "edits-export",
      "--output-path",
      path.join(profile, "unwritten.mp4"),
      "--dry-run",
    );
    expect(planned.data.attempted).toBe(false);
    expect(planned.data.verified).toBe(false);
    expect(
      await access(path.join(profile, "unwritten.mp4")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
