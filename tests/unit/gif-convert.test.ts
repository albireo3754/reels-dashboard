import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GifConverter, gifPlan } from "../../src/features/gif-convert";
import { gifConvertInput } from "../../src/shared/gif-convert";
import { createAgentDispatch, toolDefinitions } from "../../src/features/agent-tools";
import { AgentSession } from "../../src/entities/agent-session";

const execute = promisify(execFile);
const runtime = path.resolve(process.env.EDITOR_RUNTIME_ROOT ?? "native/editor-engine/.build/runtime");
const hasRuntime = existsSync(path.join(runtime, "bin/ffmpeg"));

const iphone = gifPlan.sourceInfo(
  {
    width: 1920,
    height: 1080,
    pix_fmt: "yuv420p10le",
    color_transfer: "arib-std-b67",
    avg_frame_rate: "30/1",
    side_data_list: [{}, { rotation: -90 }, {}],
  },
  8,
);

test("plan reads an iPhone HLG portrait clip like the playback proxy", () => {
  assert.deepEqual(
    { rotation: iphone.rotation, hdr: iphone.hdr, highBitDepth: iphone.highBitDepth, fps: iphone.fps },
    { rotation: 270, hdr: true, highBitDepth: true, fps: 30 },
  );
  assert.deepEqual(gifPlan.displaySize(iphone), { width: 1080, height: 1920 });
  assert.deepEqual(gifPlan.outputSize(iphone, 480), { width: 480, height: 854 });
  // Never upscaled.
  assert.deepEqual(gifPlan.outputSize(iphone, 1080), { width: 1080, height: 1920 });
  assert.equal(gifPlan.outputFps(iphone, 30), 30);
  assert.equal(gifPlan.outputFps({ ...iphone, fps: 24 }, 30), 24);
  const gpu = gifPlan.frameFilters("videotoolbox", iphone, { width: 480, height: 854 }, 15);
  assert.equal(
    gpu,
    "fps=15,transpose_vt=dir=clock,scale_vt=w=480:h=854:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le",
  );
  const cpu = gifPlan.frameFilters("cpu", iphone, { width: 480, height: 854 }, 15);
  assert.match(cpu, /^fps=15,transpose=clock,scale=480:854:flags=lanczos,zscale=t=linear/);
  assert.match(cpu, /tonemap=tonemap=hable/);
  const sdr = gifPlan.frameFilters("videotoolbox", { ...iphone, hdr: false, highBitDepth: false, rotation: 0 }, { width: 480, height: 270 }, 15);
  assert.equal(sdr, "fps=15,scale_vt=w=480:h=270,hwdownload,format=nv12");
  assert.equal(gifPlan.gpuSupported({ ...iphone, mirrored: true }), false);
  assert.throws(() => gifPlan.frameFilters("cpu", { ...iphone, rotation: 45 }, { width: 2, height: 2 }, 1), /GIF_SOURCE/);
});

test("encode removes audio and metadata, loops forever and uses one palette", () => {
  const range = { start: 1.5, duration: 3 };
  const args = gifPlan.encodeArgs("videotoolbox", "/in.mov", iphone, range, { width: 480, height: 854 }, 15, "bayer", "/p.png", "/out.gif");
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("-ss"), "1.5");
  assert.equal(after("-t"), "3");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "input seek");
  assert.equal(after("-map_metadata"), "-1");
  assert.equal(after("-loop"), "0");
  assert.ok(args.includes("-an"));
  assert.match(after("-filter_complex"), /paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle/);
  const palette = gifPlan.paletteArgs("videotoolbox", "/in.mov", iphone, range, { width: 480, height: 854 }, 15, "/p.png");
  assert.match(palette[palette.indexOf("-vf") + 1], /^fps=15,.*palettegen=stats_mode=full$/);
  assert.equal(gifPlan.paletteFps(8, 15), 6);
  assert.equal(gifPlan.paletteFps(60, 15), 1);
  assert.equal(gifPlan.paletteFps(1, 15), 15);
});

test("range and size-fitting rules", () => {
  assert.deepEqual(gifPlan.clampRange(iphone), { start: 0, end: 8, duration: 8 });
  assert.deepEqual(gifPlan.clampRange(iphone, 2, 99), { start: 2, end: 8, duration: 6 });
  assert.throws(() => gifPlan.clampRange(iphone, 8), /GIF_RANGE/);
  assert.throws(() => gifPlan.clampRange({ ...iphone, duration: 120 }), /최대 60초/);
  // fps first (not below 10), then width (not below 240).
  assert.deepEqual(gifPlan.nextAttempt({ width: 480, fps: 15 }, 23e6, 19e6), { width: 480, fps: 11 });
  assert.deepEqual(gifPlan.nextAttempt({ width: 480, fps: 15 }, 21e6, 20e6), { width: 480, fps: 13 });
  assert.deepEqual(gifPlan.nextAttempt({ width: 480, fps: 10 }, 30e6, 15e6), { width: 330, fps: 10 });
  assert.equal(gifPlan.nextAttempt({ width: 240, fps: 10 }, 30e6, 15e6), undefined);
});

test("input schema and MCP tool registration", async () => {
  const ok = { sourcePath: "/a/b.mov", outputPath: "/a/b.gif" };
  assert.ok(gifConvertInput.safeParse(ok).success);
  assert.equal(gifConvertInput.safeParse({ ...ok, outputPath: "/a/b.mp4" }).success, false);
  assert.equal(gifConvertInput.safeParse({ ...ok, outputPath: "relative.gif" }).success, false);
  assert.equal(gifConvertInput.safeParse({ ...ok, start: 3, end: 2 }).success, false);
  assert.equal(gifConvertInput.safeParse({ ...ok, width: 4000 }).success, false);
  assert.equal(gifConvertInput.safeParse({ ...ok, extra: 1 }).success, false);
  assert.equal(toolDefinitions.reels_convert_gif.readOnly, false);
  const calls: unknown[] = [];
  const dispatch = createAgentDispatch({
    gif: { convert: async (input: any) => (calls.push(input), { outputPath: input.outputPath } as any) },
    session: new AgentSession(),
  } as any);
  assert.deepEqual(await dispatch("reels_convert_gif", { ...ok, fps: 12 }), { outputPath: "/a/b.gif" });
  assert.deepEqual(calls, [{ ...ok, fps: 12 }]);
  await assert.rejects(
    createAgentDispatch({ session: new AgentSession() } as any)("reels_convert_gif", ok),
    /UNSUPPORTED/,
  );
});

test("converter validates paths before running anything", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gif-validate-"));
  try {
    const source = path.join(directory, "clip.mov");
    await writeFile(source, "not a video");
    let ran = 0;
    const converter = new GifConverter(runtime, undefined, async () => {
      ran++;
      throw new Error("must not run");
    });
    await assert.rejects(converter.convert({ sourcePath: path.join(directory, "none.mov"), outputPath: path.join(directory, "a.gif") }), /GIF_SOURCE/);
    await assert.rejects(converter.convert({ sourcePath: path.join(directory, "clip.mov"), outputPath: path.join(directory, "missing/a.gif") }), /GIF_OUTPUT/);
    await writeFile(path.join(directory, "taken.gif"), "x");
    await assert.rejects(converter.convert({ sourcePath: source, outputPath: path.join(directory, "taken.gif") }), /GIF_OUTPUT_EXISTS/);
    await writeFile(path.join(directory, "clip.txt"), "x");
    await assert.rejects(converter.convert({ sourcePath: path.join(directory, "clip.txt"), outputPath: path.join(directory, "b.gif") }), /mov\/mp4\/m4v/);
    assert.equal(ran, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(directory: string) {
  const ffmpeg = path.join(runtime, "bin/ffmpeg");
  const plain = path.join(directory, "plain.mov");
  const source = path.join(directory, "회전 HLG.mov");
  // Synthetic 10-bit HLG HEVC with audio, a 90° display matrix and a location tag.
  await execute(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx265",
    "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
    "-pix_fmt", "yuv420p10le", "-color_trc", "arib-std-b67", "-color_primaries", "bt2020", "-colorspace", "bt2020nc",
    "-tag:v", "hvc1", "-c:a", "aac", "-shortest", plain]);
  await execute(ffmpeg, ["-y", "-v", "error", "-display_rotation:v:0", "90", "-i", plain, "-map", "0", "-c", "copy",
    "-metadata", "location=+37.5665+126.9780/", source]);
  return source;
}

async function probeGif(file: string) {
  const { stdout } = await execute(path.join(runtime, "bin/ffprobe"), ["-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames", "-of", "json", file]);
  return JSON.parse(stdout).streams as Array<Record<string, unknown>>;
}

test("real conversion: GPU route, rotation, no audio/metadata, infinite loop", { skip: !hasRuntime && "bundled editor runtime not built" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gif-real-"));
  try {
    const source = await fixture(directory);
    const before = await readFile(source);
    const output = path.join(directory, "결과.gif");
    const result = await new GifConverter(runtime).convert({ sourcePath: source, outputPath: output });
    assert.equal(result.outputPath, output);
    assert.equal(result.accel, "videotoolbox");
    assert.equal(result.hdrToSDR, true);
    assert.equal(result.rotation, 90);
    assert.deepEqual([result.width, result.height, result.fps], [180, 320, 15]);
    assert.equal(result.durationSeconds, 2);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.bytes, (await stat(output)).size);
    const streams = await probeGif(output);
    assert.deepEqual(streams.map((s) => [s.codec_type, s.codec_name, s.width, s.height]), [["video", "gif", 180, 320]]);
    assert.equal(Number(streams[0].nb_read_frames), 30);
    const bytes = await readFile(output);
    const netscape = bytes.indexOf("NETSCAPE2.0");
    assert.ok(netscape > 0, "loop extension");
    assert.deepEqual([...bytes.subarray(netscape + 11, netscape + 15)], [3, 1, 0, 0], "loop count 0 = forever");
    assert.equal(bytes.includes("37.5665"), false, "no location");
    assert.deepEqual(await readFile(source), before, "source untouched");
    // Range + explicit settings; partial files never stay next to the output.
    const ranged = await new GifConverter(runtime).convert({ sourcePath: source, outputPath: path.join(directory, "구간.gif"), start: 0.5, end: 1.5, width: 120, fps: 10, dither: "smooth" });
    assert.deepEqual([ranged.width, ranged.height, ranged.fps, ranged.durationSeconds, ranged.start, ranged.end], [120, 214, 10, 1, 0.5, 1.5]);
    assert.equal(Number((await probeGif(ranged.outputPath))[0].nb_read_frames), 10);
    const leftovers = (await import("node:fs/promises")).readdir(directory);
    assert.deepEqual((await leftovers).filter((f) => f.includes(".partial")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real conversion falls back to CPU when VideoToolbox fails, and fits maxBytes", { skip: !hasRuntime && "bundled editor runtime not built" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gif-cpu-"));
  try {
    const source = await fixture(directory);
    const exec = promisify(execFile);
    const converter = new GifConverter(runtime, undefined, (executable, args) => {
      if (args.includes("videotoolbox")) return Promise.reject(Object.assign(new Error("vt"), { stderr: "VT unavailable" }));
      return exec(executable, args);
    });
    const result = await converter.convert({ sourcePath: source, outputPath: path.join(directory, "cpu.gif") });
    assert.equal(result.accel, "cpu");
    assert.deepEqual([result.width, result.height], [180, 320]);
    assert.match(result.warnings[0], /CPU 경로/);
    const fitted = await new GifConverter(runtime).convert({ sourcePath: source, outputPath: path.join(directory, "fit.gif"), fps: 30, maxBytes: 256 * 1024 });
    assert.ok(fitted.attempts.length >= 2, JSON.stringify(fitted.attempts));
    assert.ok(fitted.bytes <= 256 * 1024);
    assert.equal(fitted.fps, fitted.attempts.at(-1)!.fps);
    for (let i = 1; i < fitted.attempts.length; i++)
      assert.ok(fitted.attempts[i].fps < fitted.attempts[i - 1].fps || fitted.attempts[i].width < fitted.attempts[i - 1].width);
    assert.equal(fitted.bytes, fitted.attempts.at(-1)!.bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
