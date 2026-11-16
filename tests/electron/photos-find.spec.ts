import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";
const exec = promisify(execFile);

test("bundled CLI finds metadata through the running Electron dispatcher", async () => {
  const profile = await makeProfile();
  const app = await launchApp(profile, false, { REELS_PHOTOS_DEMO_QA: "1" });
  try {
    const invoke = async (args:string[]) => {
      const {stdout} = await exec(process.execPath,[path.resolve("dist-cli/reels.mjs"),...args],{env:{...process.env,REELS_USER_DATA:profile}});
      return JSON.parse(stdout);
    };
    await expect.poll(async () => (await invoke(["status"])).data.app.online).toBe(true);
    const result = await invoke(["photos-find","--date","2026-01-15","--min-duration","0","--max-duration","60"]);
    expect(result.ok).toBe(true);
    expect(result.data.matches.length).toBeGreaterThan(0);
    for (const asset of result.data.matches) {
      expect(asset.mediaKind).toBe("video");
      expect(asset.durationSeconds).toBeLessThanOrEqual(60);
      const detail = await invoke(["photos-group","--group-id",asset.groupId,"--index-run-id",asset.indexRunId]);
      expect(detail.data.assets.some((a:any) => a.id === asset.id)).toBe(true);
    }
  } finally { await closeApp(app); await cleanProfile(profile); }
});
