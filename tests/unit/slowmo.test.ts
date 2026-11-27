import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SlowmoService, slowmoPlan, type SlowmoRunner as Runner } from "../../src/features/slowmo";
import { slowmoStartInput } from "../../src/shared/slowmo";
import { createAgentDispatch, toolDefinitions } from "../../src/features/agent-tools";
import { AgentSession } from "../../src/entities/agent-session";

const execute = promisify(execFile);
const native = path.resolve(process.env.SLOWMO_BIN ?? "native/editor-engine/.build/reels-slowmo");
const hasNative = existsSync(native) && existsSync("/opt/homebrew/bin/ffmpeg");

const probe = { width: 1080, height: 1920, duration: 24.5, fps: 29.998, hdr: false, hasAudio: true };

test("plan defaults to half speed at the rounded source rate and checks ranges", () => {
  const plan = slowmoPlan.plan(probe, { start: 8, end: 12 });
  assert.deepEqual(
    { start: plan.start, end: plan.end, speed: plan.speed, fps: plan.fps, outputSeconds: plan.outputSeconds },
    { start: 8, end: 12, speed: 0.5, fps: 30, outputSeconds: 8 },
  );
  assert.ok(plan.warnings.some((w) => w.includes("소리")));
  assert.equal(slowmoPlan.plan(probe, { end: 99 }).end, 24.5);
  assert.throws(() => slowmoPlan.plan(probe, { start: 30 }), /SLOWMO_RANGE/);
  assert.throws(() => slowmoPlan.plan({ ...probe, duration: 120 }, {}), /SLOWMO_RANGE: 한 번에 원본 60초/);
  // 60 s at the slowest speed is exactly the 600 s result cap.
  assert.equal(slowmoPlan.plan({ ...probe, duration: 60 }, { speed: 0.1 }).outputSeconds, 600);
  // A 120 fps source slowed to 0.25x at 30 fps needs no new frames: say so.
  assert.equal(slowmoPlan.plan({ ...probe, fps: 240 }, {}).fps, 60);
  assert.ok(slowmoPlan.plan({ ...probe, fps: 120 }, { speed: 0.25, fps: 30 }).warnings.some((w) => w.includes("새 프레임이 거의 필요 없어요")));
});

test("input schema accepts mov/mp4 outputs and rejects bad speed and ranges", () => {
  const ok = { sourcePath: "/a/clip.mov", outputPath: "/a/slow.mov" };
  assert.equal(slowmoStartInput.safeParse(ok).success, true);
  assert.equal(slowmoStartInput.safeParse({ ...ok, outputPath: "/a/slow.mp4", speed: 0.25, fps: 60 }).success, true);
  assert.equal(slowmoStartInput.safeParse({ ...ok, outputPath: "/a/slow.gif" }).success, false);
  assert.equal(slowmoStartInput.safeParse({ ...ok, speed: 1 }).success, false);
  assert.equal(slowmoStartInput.safeParse({ ...ok, start: 5, end: 4 }).success, false);
  assert.equal(slowmoStartInput.safeParse({ ...ok, outputPath: "relative.mov" }).success, false);
});

test("tools are registered and dispatch to the slowmo port", async () => {
  for (const name of ["reels_start_slowmo", "reels_get_slowmo_job", "reels_cancel_slowmo"] as const)
    assert.ok(toolDefinitions[name], name);
  assert.equal(toolDefinitions.reels_get_slowmo_job.readOnly, true);
  const calls: unknown[] = [];
  const dispatch = createAgentDispatch({
    slowmo: {
      start: async (input: unknown) => (calls.push(input), { id: "j1" } as any),
      get: (id: string) => ({ id, state: "running" }) as any,
      cancel: async (id: string) => ({ id, state: "cancelled" }) as any,
    },
    session: new AgentSession(),
  } as any);
  const ok = { sourcePath: "/a/clip.mov", outputPath: "/a/slow.mov", speed: 0.5 };
  assert.deepEqual(await dispatch("reels_start_slowmo", ok), { id: "j1" });
  assert.deepEqual(calls, [ok]);
  assert.deepEqual(await dispatch("reels_get_slowmo_job", { jobId: "j1" }), { id: "j1", state: "running" });
  assert.deepEqual(await dispatch("reels_cancel_slowmo", { jobId: "j1" }), { id: "j1", state: "cancelled" });
  await assert.rejects(createAgentDispatch({ session: new AgentSession() } as any)("reels_start_slowmo", ok), /UNSUPPORTED/);
});

/** Fake native tool: probe answers, render writes the requested output after a tick. */
function fakeRunner(options: { fail?: string; hold?: boolean } = {}) {
  const requests: Record<string, unknown>[] = [];
  let release: () => void = () => undefined;
  const runner: Runner = (command, argument, onProgress) => {
    if (command === "probe") return { done: Promise.resolve({ ...probe, type: "result" }), cancel() {} };
    let cancelled = false;
    let reject: (e: Error) => void = () => undefined;
    const done = new Promise<Record<string, unknown>>((resolve, fail) => {
      reject = fail;
      void (async () => {
        const request = JSON.parse(await readFile(argument, "utf8"));
        requests.push(request);
        onProgress(50);
        if (options.hold) await new Promise<void>((r) => (release = r));
        if (cancelled) return;
        if (options.fail) return fail(new Error(options.fail));
        await writeFile(request.output, "video");
        resolve({ type: "result", frames: 240, interpolatedFrames: 214, fps: request.fps, durationSeconds: 8, width: 1080, height: 1920, hdr: false, codec: "h264" });
      })();
    });
    return {
      done,
      cancel() {
        cancelled = true;
        reject(new Error("cancelled"));
        release();
      },
    };
  };
  return { runner, requests, release: () => release() };
}

async function folder() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slowmo-unit-"));
  const source = path.join(directory, "clip.mov");
  await writeFile(source, "source");
  return { directory, source };
}

test("service renders through a hidden partial file and reports the result", async () => {
  const { directory, source } = await folder();
  try {
    const fake = fakeRunner();
    const service = new SlowmoService("/unused", undefined, fake.runner);
    const output = path.join(directory, "slow.mov");
    const job = await service.start({ sourcePath: source, outputPath: output, start: 8, end: 12 });
    assert.equal(job.state === "queued" || job.state === "running", true);
    assert.equal(service.busy, true);
    const done = await service.wait(job.id);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.percent, 100);
    assert.equal(done.result?.outputPath, output);
    assert.equal(done.result?.speed, 0.5);
    assert.equal(done.result?.interpolatedFrames, 214);
    assert.equal(done.result?.audio, "removed");
    assert.equal(await readFile(output, "utf8"), "video");
    assert.equal(await readFile(source, "utf8"), "source");
    const request = fake.requests[0]!;
    assert.match(String(request.output), /\/\.slow\.mov\..+\.partial\.mov$/);
    assert.deepEqual([request.start, request.duration, request.speed, request.fps], [8, 4, 0.5, 30]);
    assert.deepEqual((await readdir(directory)).sort(), ["clip.mov", "slow.mov"]);
    assert.equal(service.busy, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service refuses existing outputs, the source itself and non-video files before running", async () => {
  const { directory, source } = await folder();
  try {
    const fake = fakeRunner();
    const service = new SlowmoService("/unused", undefined, fake.runner);
    const existing = path.join(directory, "taken.mov");
    await writeFile(existing, "keep");
    await assert.rejects(service.start({ sourcePath: source, outputPath: existing }), /SLOWMO_OUTPUT_EXISTS/);
    await assert.rejects(service.start({ sourcePath: source, outputPath: source, overwrite: true }), /원본을 덮어쓸 수 없어요/);
    const text = path.join(directory, "note.txt");
    await writeFile(text, "x");
    await assert.rejects(service.start({ sourcePath: text, outputPath: path.join(directory, "a.mov") }), /mov\/mp4\/m4v/);
    await assert.rejects(service.start({ sourcePath: source, outputPath: path.join(directory, "missing/a.mov") }), /저장할 폴더가 없어요/);
    assert.equal(fake.requests.length, 0);
    assert.equal(await readFile(existing, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed and cancelled jobs leave no partial file", async () => {
  const { directory, source } = await folder();
  try {
    const failing = new SlowmoService("/unused", undefined, fakeRunner({ fail: "SLOWMO_ENCODE: boom" }).runner);
    const failed = await failing.wait((await failing.start({ sourcePath: source, outputPath: path.join(directory, "f.mov") })).id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "SLOWMO_ENCODE: boom");

    const held = fakeRunner({ hold: true });
    const service = new SlowmoService("/unused", undefined, held.runner);
    const job = await service.start({ sourcePath: source, outputPath: path.join(directory, "c.mov") });
    while (held.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
    const cancelled = await service.cancel(job.id);
    assert.equal(cancelled.state, "cancelled");
    assert.deepEqual(await readdir(directory), ["clip.mov"]);
    assert.throws(() => service.get("nope"), /SLOWMO_JOB/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native reels-slowmo doubles frames on the GPU and keeps rotation", { skip: !hasNative && "build native/editor-engine/.build/reels-slowmo first" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slowmo-native-"));
  try {
    const plain = path.join(directory, "plain.mov");
    const source = path.join(directory, "src.mov");
    await execute("/opt/homebrew/bin/ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
      "-c:v", "h264_videotoolbox", "-b:v", "2M", plain]);
    // Portrait like an iPhone clip: a display matrix, not rotated pixels.
    await execute("/opt/homebrew/bin/ffmpeg", ["-loglevel", "error", "-display_rotation", "90", "-i", plain, "-c", "copy", source]);
    const output = path.join(directory, "slow.mov");
    const service = new SlowmoService(native);
    const done = await service.wait((await service.start({ sourcePath: source, outputPath: output, start: 0.5, end: 1.5 })).id);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.result?.frames, 60);
    assert.ok((done.result?.interpolatedFrames ?? 0) >= 25, `interpolated ${done.result?.interpolatedFrames}`);
    assert.equal(done.result?.codec, "h264");
    assert.deepEqual([done.result?.width, done.result?.height], [240, 320]);
    const { stdout } = await execute("/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
      "-show_entries", "stream=nb_read_frames,avg_frame_rate,codec_name:stream_side_data=rotation:format=duration", "-of", "json", output]);
    const info = JSON.parse(stdout);
    assert.equal(info.streams[0].nb_read_frames, "60");
    assert.equal(info.streams[0].avg_frame_rate, "30/1");
    assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.05);
    assert.equal(Math.abs(Number(info.streams[0].side_data_list?.[0]?.rotation)), 90);
    assert.ok((await stat(output)).size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
