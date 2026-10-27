import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  readdir,
  access,
  realpath,
  stat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { EditorProject, RenderJob } from "../../src/shared/editor";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

const execute = promisify(execFile);
const runtime = process.env.REELS_ELECTRON_EXECUTABLE
  ? path.resolve(
      path.dirname(process.env.REELS_ELECTRON_EXECUTABLE),
      "../Resources/editor-runtime",
    )
  : path.resolve("native/editor-engine/.build/runtime");
const mediaTool = (name: string) => path.join(runtime, "bin", name);
const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const exists = async (file: string) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

async function syntheticVideo(file: string, duration: number) {
  await execute(
    mediaTool("ffmpeg"),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1080x1920:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      file,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
}

async function chooseInput(app: ElectronApplication, page: Page, file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
  const project = await page.evaluate(() => window.reels!.editor.chooseVideo());
  expect(project).not.toBeNull();
  return project!;
}

async function chooseOutput(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
}

function edited(project: EditorProject): EditorProject {
  const result = structuredClone(project);
  result.settings.place.name = "테스트 공원";
  result.settings.place.description = "촬영과 편집을 확인하는 예시예요";
  result.settings.place.material = "tape";
  result.settings.place.useDefaultPosition = false;
  result.settings.place.x = 0.5;
  result.settings.place.y = 0.22;
  result.settings.place.size = 0.042;
  result.settings.captions.items = [
    {
      id: "qa-caption",
      start: 0.2,
      end: 2.5,
      text: "오늘은 공원에서 영상을 찍었어요.",
    },
  ];
  result.settings.cover.time = 0.75;
  result.settings.cover.hook = "영상 편집\n확인했어요";
  return result;
}

async function workCount(profile: string, projectID: string) {
  try {
    return (await readdir(path.join(profile, "editor", projectID, "work")))
      .length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

test.describe("real bundled editor runtime", () => {
  test.skip(
    process.env.REELS_EDITOR_QA !== "1",
    "Requires the built native editor runtime; uses only generated synthetic media.",
  );
  test.setTimeout(180_000);
  let app: ElectronApplication | undefined;
  let profile: string;
  let runningJob: string | undefined;
  let projectID: string | undefined;

  test.beforeEach(async () => {
    profile = await makeProfile();
    app = await launchApp(profile, false);
    const page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.reels?.mode))
      .toBe("desktop");
    expect(
      (await page.evaluate(() => window.reels!.editor.runtime())).available,
    ).toBe(true);
  });
  test.afterEach(async () => {
    if (app && runningJob) {
      const page = await app.firstWindow();
      await page
        .evaluate((id) => window.reels!.editor.cancel(id), runningJob)
        .catch(() => {});
    }
    if (projectID)
      await expect
        .poll(() => workCount(profile, projectID!), { timeout: 15_000 })
        .toBe(0);
    await closeApp(app);
    app = undefined;
    runningJob = undefined;
    projectID = undefined;
    await cleanProfile(profile);
  });

  test("imports, seeks, previews, exports real video/audio/cover and reloads a trusted project", async ({}, testInfo) => {
    const input = path.join(profile, "예시 촬영 원본.mp4");
    const output = path.join(profile, "편집 결과.mov");
    await syntheticVideo(input, 3);
    const originalHash = await digest(input);
    let page = await app!.firstWindow();
    const source = await chooseInput(app!, page, input);
    projectID = source.id;
    expect(source.source.width).toBe(1080);
    expect(source.source.height).toBe(1920);
    expect(source.source.hasAudio).toBe(true);
    expect(source.source.duration).toBeCloseTo(3, 1);
    const stream = await page.evaluate(async (url) => {
      const range = await fetch(url, { headers: { Range: "bytes=0-127" } });
      const bytes = (await range.arrayBuffer()).byteLength;
      const head = await fetch(url, { method: "HEAD" });
      const headBytes = (await head.arrayBuffer()).byteLength;
      const invalid = await fetch(url, {
        headers: { Range: "bytes=999999999-" },
      });
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      const loaded = new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), {
          once: true,
        });
        video.addEventListener(
          "error",
          () => reject(new Error("Proxy failed to load")),
          { once: true },
        );
      });
      video.src = url;
      await loaded;
      const sought = new Promise<void>((resolve, reject) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.addEventListener(
          "error",
          () => reject(new Error("Proxy failed to seek")),
          { once: true },
        );
      });
      video.currentTime = 1.25;
      await sought;
      const currentTime = video.currentTime;
      const duration = video.duration;
      video.removeAttribute("src");
      video.load();
      return {
        status: range.status,
        contentRange: range.headers.get("content-range"),
        bytes,
        currentTime,
        duration,
        headStatus: head.status,
        headBytes,
        headLength: Number(head.headers.get("content-length")),
        invalidStatus: invalid.status,
        invalidContentRange: invalid.headers.get("content-range"),
      };
    }, source.source.videoURL);
    expect(stream.status).toBe(206);
    expect(stream.bytes).toBe(128);
    expect(stream.contentRange).toMatch(/^bytes 0-127\/\d+$/);
    expect(stream.currentTime).toBeCloseTo(1.25, 2);
    expect(stream.duration).toBeCloseTo(3, 1);
    expect(stream.headStatus).toBe(200);
    expect(stream.headBytes).toBe(0);
    expect(stream.headLength).toBeGreaterThan(128);
    expect(stream.invalidStatus).toBe(416);
    expect(stream.invalidContentRange).toMatch(/^bytes \*\/\d+$/);
    const foreignOrigin = await app!.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url, {
        headers: { Origin: "https://untrusted.invalid" },
      });
      return response.status;
    }, source.source.videoURL);
    expect(foreignOrigin).toBe(403);
    let project = edited(source);
    project = await page.evaluate((p) => window.reels!.editor.save(p), project);
    const tamper = await page.evaluate(async (p) => {
      const original = structuredClone(p);
      p.source.name = "untrusted-source";
      p.source.videoURL = "file:///etc/passwd";
      p.source.width = 1;
      p.source.height = 1;
      await window.reels!.editor.save(p);
      const actual = await window.reels!.editor.load(p.id);
      let invalidIDRejected = false;
      try {
        await window.reels!.editor.preview(
          { ...p, id: "../../etc/passwd" },
          0,
          "video",
        );
      } catch {
        invalidIDRejected = true;
      }
      return {
        actualSource: actual.source,
        expectedSource: original.source,
        invalidIDRejected,
      };
    }, project);
    expect(tamper.actualSource).toEqual(tamper.expectedSource);
    expect(tamper.invalidIDRejected).toBe(true);
    project = await page.evaluate(
      (id) => window.reels!.editor.load(id),
      project.id,
    );
    for (const kind of ["video", "cover"] as const) {
      const image = await page.evaluate(
        ({ p, kind }) => window.reels!.editor.preview(p, 0.75, kind),
        { p: project, kind },
      );
      expect(image).toMatch(/^data:image\/png;base64,/);
      const decoded = await page.evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      }, image);
      expect(decoded).toEqual({ width: 1080, height: 1920 });
      await writeFile(
        testInfo.outputPath(`synthetic-${kind}-preview.png`),
        Buffer.from(image.split(",")[1]!, "base64"),
      );
    }
    await chooseOutput(app!, input);
    expect(
      await page.evaluate(async (p) => {
        try {
          await window.reels!.editor.export(p);
          return false;
        } catch {
          return true;
        }
      }, project),
    ).toBe(true);
    await expect.poll(() => workCount(profile, project.id)).toBe(0);
    expect(await digest(input)).toBe(originalHash);
    await chooseOutput(app!, output);
    const job = await page.evaluate(
      (p) => window.reels!.editor.export(p),
      project,
    );
    expect(job).not.toBeNull();
    runningJob = job!.id;
    let finalJob: RenderJob = job!;
    await expect
      .poll(
        async () => {
          finalJob = await page.evaluate(
            (id) => window.reels!.editor.job(id),
            job!.id,
          );
          return finalJob.state;
        },
        { timeout: 90_000, intervals: [100, 250, 500] },
      )
      .not.toBe("running");
    expect(finalJob.state, finalJob.error).toBe("completed");
    expect(finalJob.progress).toBe(100);
    expect(finalJob.outputPath).toBe(output);
    expect(await exists(finalJob.coverPath!)).toBe(true);
    await expect.poll(() => workCount(profile, project.id)).toBe(0);
    runningJob = undefined;
    const probe = JSON.parse(
      (
        await execute(mediaTool("ffprobe"), [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          output,
        ])
      ).stdout,
    );
    expect(
      probe.streams.find(
        (s: { codec_type: string }) => s.codec_type === "video",
      ),
    ).toMatchObject({ width: 1080, height: 1920 });
    expect(
      probe.streams.some(
        (s: { codec_type: string }) => s.codec_type === "audio",
      ),
    ).toBe(true);
    expect(Number(probe.format.duration)).toBeCloseTo(3, 1);
    const manifest = JSON.parse(
      await readFile(output.replace(/\.[^.]+$/, ".style.json"), "utf8"),
    );
    expect(manifest.size).toEqual([1080, 1920]);
    expect(JSON.stringify(manifest)).toContain(project.settings.place.name);
    expect(
      await exists(finalJob.coverPath!.replace(/\.png$/, ".style.json")),
    ).toBe(true);
    expect(await digest(input)).toBe(originalHash);
    const dashboard = await page.evaluate(() => window.reels!.loadDashboard());
    expect(dashboard.projects.find((p) => p.id === project.id)?.stage).toBe(
      "review",
    );
    project = await page.evaluate(
      (id) => window.reels!.editor.load(id),
      project.id,
    );
    project = await page.evaluate((p) => window.reels!.editor.save(p), project);
    expect(
      (await page.evaluate(() => window.reels!.loadDashboard())).projects.find(
        (p) => p.id === project.id,
      )?.stage,
    ).toBe("review");
    project.settings.captions.items[0]!.text = "다시 편집한 자막이에요.";
    project = await page.evaluate((p) => window.reels!.editor.save(p), project);
    expect(
      (await page.evaluate(() => window.reels!.loadDashboard())).projects.find(
        (p) => p.id === project.id,
      )?.stage,
    ).toBe("editing");
    await closeApp(app);
    app = undefined;
    app = await launchApp(profile, false);
    page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => Boolean(window.reels?.editor)))
      .toBe(true);
    const loaded = await page.evaluate(
      (id) => window.reels!.editor.load(id),
      project.id,
    );
    expect(loaded.settings).toEqual(project.settings);
    expect(loaded.source).toEqual(project.source);
    expect(
      (await page.evaluate(() => window.reels!.editor.list())).some(
        (p) => p.id === project.id,
      ),
    ).toBe(true);
    await testInfo.attach("synthetic-render-summary", {
      contentType: "application/json",
      body: JSON.stringify({
        video: true,
        audio: true,
        cover: true,
        manifests: true,
        sourceUnchanged: true,
        restartRestored: true,
      }),
    });
  });

  test("cancels a real in-progress render without publishing output or changing its source", async () => {
    const input = path.join(profile, "cancel-source.mp4");
    const output = path.join(profile, "cancel-output.mov");
    await syntheticVideo(input, 30);
    const originalHash = await digest(input);
    const page = await app!.firstWindow();
    const project = edited(await chooseInput(app!, page, input));
    projectID = project.id;
    await chooseOutput(app!, output);
    const job = await page.evaluate(
      (p) => window.reels!.editor.export(p),
      project,
    );
    expect(job).not.toBeNull();
    runningJob = job!.id;
    await expect
      .poll(
        async () => {
          const current = await page.evaluate(
            (id) => window.reels!.editor.job(id),
            job!.id,
          );
          if (current.state !== "running")
            throw new Error(
              `Render became ${current.state} before the cancellation checkpoint`,
            );
          return current.progress;
        },
        { timeout: 45_000, intervals: [50, 100] },
      )
      .toBeGreaterThan(0);
    await page.evaluate((id) => window.reels!.editor.cancel(id), job!.id);
    expect(
      (await page.evaluate((id) => window.reels!.editor.job(id), job!.id))
        .state,
    ).toBe("cancelled");
    await expect
      .poll(() => workCount(profile, project.id), { timeout: 15_000 })
      .toBe(0);
    runningJob = undefined;
    for (const file of [
      output,
      output.replace(/\.mov$/, "_cover.png"),
      output.replace(/\.mov$/, ".style.json"),
      output.replace(/\.mov$/, "_cover.style.json"),
    ])
      expect(await exists(file)).toBe(false);
    expect(await digest(input)).toBe(originalHash);
  });

  test("hands one explicitly approved Photos video to the real editor", async ({}, testInfo) => {
    test.skip(
      process.env.REELS_LIVE_EDITOR_QA !== "1",
      "Requires explicit permission to prepare one private Photos editing copy.",
    );
    const primary = process.env.REELS_LIVE_EDITOR_DATE;
    const fallback = process.env.REELS_LIVE_EDITOR_FALLBACK_DATE;
    expect(primary).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (fallback) expect(fallback).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const page = await app!.firstWindow();
    const result = await page.evaluate(
      async (dates) => {
        const bridge = window.reels!;
        const status = await bridge.request<{ permission: string }>("status");
        if (status.permission !== "authorized")
          throw new Error(
            "Full Photos authorization is required for this opt-in handoff check",
          );
        let inspectedGroups = 0;
        for (const date of dates) {
          const sync = await bridge.request<{ indexRunID: string }>("sync", {
            date,
          });
          const groups = await bridge.request<{
            indexRunID: string;
            groups: { id: string }[];
          }>("groups.list", { date, level: "fine" });
          if (groups.indexRunID !== sync.indexRunID)
            throw new Error("Capture group run changed before handoff");
          for (const group of groups.groups.slice(0, 3)) {
            const detail = await bridge.request<{
              indexRunID: string;
              assets: {
                id: string;
                mediaKind: string;
                durationSeconds: number;
              }[];
            }>("groups.show", { id: group.id, "index-run": sync.indexRunID });
            inspectedGroups++;
            if (detail.indexRunID !== sync.indexRunID)
              throw new Error("Capture detail run changed before handoff");
            const candidate = detail.assets
              .filter(
                (asset) =>
                  asset.mediaKind === "video" &&
                  asset.durationSeconds > 0 &&
                  asset.durationSeconds <= 30,
              )
              .sort((a, b) => a.durationSeconds - b.durationSeconds)[0];
            if (!candidate) continue;
            const project = await bridge.editor.fromPhotos({
              groupID: group.id,
              indexRunID: sync.indexRunID,
              assetID: candidate.id,
            });
            if (
              !(
                project.source.duration > 0 &&
                project.source.duration <= 31 &&
                project.source.width > 0 &&
                project.source.height > 0
              ) ||
              !project.source.videoURL.startsWith("reels-media://video/")
            )
              throw new Error(
                "Materialized editing source metadata was invalid",
              );
            const video = document.createElement("video");
            video.muted = true;
            video.preload = "auto";
            const loaded = new Promise<void>((resolve, reject) => {
              video.addEventListener("loadedmetadata", () => resolve(), {
                once: true,
              });
              video.addEventListener(
                "error",
                () => reject(new Error("Private Photos proxy did not load")),
                { once: true },
              );
            });
            video.src = project.source.videoURL;
            await loaded;
            const aspectConsistent =
              Math.abs(
                video.videoWidth / video.videoHeight -
                  project.source.width / project.source.height,
              ) < 0.01;
            const sought = new Promise<void>((resolve, reject) => {
              video.addEventListener("seeked", () => resolve(), { once: true });
              video.addEventListener(
                "error",
                () => reject(new Error("Private Photos proxy did not seek")),
                { once: true },
              );
            });
            const target = Math.min(0.5, video.duration / 2);
            video.currentTime = target;
            await sought;
            const seekSucceeded = Math.abs(video.currentTime - target) < 0.1;
            video.removeAttribute("src");
            video.load();
            return {
              projectID: project.id,
              found: true,
              inspectedGroups,
              aspectConsistent,
              seekSucceeded,
            };
          }
        }
        return {
          projectID: "",
          found: false,
          inspectedGroups,
          aspectConsistent: false,
          seekSucceeded: false,
        };
      },
      [primary!, ...(fallback ? [fallback] : [])],
    );
    expect(
      result.found,
      "No suitable short video was found within the explicitly approved dates and first three groups per date",
    ).toBe(true);
    expect(result.inspectedGroups).toBeLessThanOrEqual(6);
    projectID = result.projectID;
    expect(result.aspectConsistent).toBe(true);
    expect(result.seekSucceeded).toBe(true);
    const record = JSON.parse(
      await readFile(
        path.join(profile, "editor", projectID, "project.json"),
        "utf8",
      ),
    ) as { sourcePath: string; proxyPath: string };
    const privateRoot = await realpath(
      path.join(profile, "native", "editor-sources"),
    );
    const privateSource = await realpath(record.sourcePath);
    expect(privateSource.startsWith(privateRoot + path.sep)).toBe(true);
    expect((await stat(privateSource)).size).toBeGreaterThan(0);
    expect((await stat(privateSource)).mode & 0o777).toBe(0o600);
    expect(await exists(record.proxyPath)).toBe(true);
    const identity = JSON.parse(
      await readFile(
        path.join(profile, "native", "helper-instance.json"),
        "utf8",
      ),
    ) as { pid: number; executablePath: string; socketPath: string };
    const resources = await app!.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      path: process.resourcesPath,
    }));
    expect(resources.packaged).toBe(true);
    const expectedHelper = await realpath(
      path.join(
        resources.path,
        "native/PhotosIndex.app/Contents/MacOS/PhotosIndex",
      ),
    );
    expect(
      (await realpath(identity.executablePath)).normalize("NFC") ===
        expectedHelper.normalize("NFC"),
    ).toBe(true);
    const command = (
      await execute(
        "/bin/ps",
        ["-ww", "-p", String(identity.pid), "-o", "command="],
        { env: { ...process.env, LC_ALL: "en_US.UTF-8" } },
      )
    ).stdout;
    expect(command.includes(identity.socketPath)).toBe(true);
    await testInfo.attach("private-photos-editor-summary", {
      contentType: "application/json",
      body: JSON.stringify({
        authorized: true,
        onePrivateVideoCopy: true,
        proxyDecoded: true,
        seekSucceeded: true,
        aspectConsistent: true,
        bundledNativeRoute: true,
      }),
    });
  });
});
