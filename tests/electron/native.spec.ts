import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

const execute = promisify(execFile);
test.describe("bundled native helper (read-only real library access)", () => {
  test.skip(
    process.env.REELS_NATIVE_QA !== "1",
    "Set REELS_NATIVE_QA=1 after the native helper is built to run real native QA.",
  );
  let app: ElectronApplication | undefined;
  let profile: string;

  test.beforeEach(async () => {
    profile = await makeProfile();
    app = await launchApp(profile, false);
  });
  test.afterEach(async () => {
    await closeApp(app);
    app = undefined;
    await cleanProfile(profile);
  });

  test("uses this build’s native helper and handles a harmless empty date", async ({}, testInfo) => {
    const page = await app!.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.reels?.mode))
      .toBe("desktop");
    const status = await page.evaluate(() =>
      window.reels!.request<{ permission: string; protocolVersion: number }>(
        "status",
      ),
    );
    expect(status.protocolVersion).toBe(1);
    expect([
      "authorized",
      "limited",
      "denied",
      "restricted",
      "not-determined",
      "unknown",
    ]).toContain(status.permission);

    const locations = await app!.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }));
    const expectedHelper = locations.packaged
      ? resolve(
          locations.resourcesPath,
          "native/PhotosIndex.app/Contents/MacOS/PhotosIndex",
        )
      : resolve(
          "native/photosindex/.build/PhotosIndex.app/Contents/MacOS/PhotosIndex",
        );
    expect(existsSync(expectedHelper)).toBe(true);
    const processes = (await execute("/bin/ps", ["-axo", "pid=,command="]))
      .stdout;
    expect(
      processes.split("\n").some((line) => line.includes(expectedHelper)),
    ).toBe(true);
    const metadataPath = join(profile, "native", "helper-instance.json");
    const identity = JSON.parse(await readFile(metadataPath, "utf8")) as {
      pid: number;
      executablePath: string;
      socketPath: string;
    };
    expect(identity.executablePath).toBe(expectedHelper);
    expect(identity.pid).toBeGreaterThan(1);
    expect(
      processes
        .split("\n")
        .some(
          (line) =>
            line.trim().startsWith(`${identity.pid} `) &&
            line.includes(identity.socketPath),
        ),
    ).toBe(true);
    await testInfo.attach("native-origin", {
      body: JSON.stringify({
        packaged: locations.packaged,
        helperFromThisBuild: true,
        protocolVersion: status.protocolVersion,
        permission: status.permission,
      }),
      contentType: "application/json",
    });

    if (status.permission === "authorized" || status.permission === "limited") {
      const result = await page.evaluate(async () => {
        const sync = await window.reels!.request<{
          assetCount: number;
          localDate: string;
        }>("sync", { date: "1900-01-01" });
        const groups = await window.reels!.request<{ groups: unknown[] }>(
          "groups.list",
          { date: "1900-01-01", level: "fine" },
        );
        return { sync, groupCount: groups.groups.length };
      });
      expect(result.sync.localDate).toBe("1900-01-01");
      expect(result.sync.assetCount).toBe(0);
      expect(result.groupCount).toBe(0);
    } else {
      const rejection = await page.evaluate(async () => {
        try {
          await window.reels!.request("sync", { date: "1900-01-01" });
          return "";
        } catch (error) {
          return String(error);
        }
      });
      expect(rejection).toMatch(/permission|access/i);
      testInfo.annotations.push({
        type: "limitation",
        description:
          "Photos permission is not granted; native metadata access remains unverified.",
      });
    }

    await closeApp(app);
    app = undefined;
    await expect.poll(() => existsSync(metadataPath)).toBe(false);
    await expect
      .poll(() => {
        try {
          process.kill(identity.pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
});
