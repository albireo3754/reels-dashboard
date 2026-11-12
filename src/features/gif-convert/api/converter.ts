import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  GIF_DEFAULT_FPS,
  GIF_DEFAULT_WIDTH,
  GIF_MAX_SECONDS,
  GIF_SIZE_WARNING_BYTES,
  gifConvertInput,
  type GifAttempt,
  type GifConvertBridge,
  type GifConvertResult,
} from "../../../shared/gif-convert";
import type { ExecutionLogs } from "../../../shared/lib/execution-logs";
import { loggedExecFile } from "../../../shared/lib/logged-process";
import {
  clampRange,
  cropPixels,
  encodeArgs,
  frameSize,
  gpuSupported,
  nextAttempt,
  outputFps,
  paletteArgs,
  sourceInfo,
  type ProbeStream,
  type Route,
  type SourceInfo,
} from "../model/plan";

type Run = (executable: string, args: string[], label: string) => Promise<{ stdout: string; stderr: string }>;

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v"]);
const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * Video -> silent looping GIF with the bundled ffmpeg (no new dependency).
 * VideoToolbox decodes, rotates, tone-maps HDR and scales on the GPU; palette
 * quantization and GIF encoding run on the CPU. One conversion at a time.
 */
export class GifConverter implements GifConvertBridge {
  private queue: Promise<unknown> = Promise.resolve();
  private run: Run;
  constructor(
    private runtime: string,
    logs?: ExecutionLogs,
    run?: Run,
  ) {
    const exec = promisify(execFile);
    this.run =
      run ??
      ((executable, args, label) =>
        logs
          ? loggedExecFile(logs, { source: "gif", label }, executable, args, { timeout: 170_000, maxBuffer: 4 * 1024 * 1024 })
          : exec(executable, args, { timeout: 170_000, maxBuffer: 4 * 1024 * 1024 }));
  }

  convert(input: unknown): Promise<GifConvertResult> {
    const job = this.queue.then(() => this.convertNow(input));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async probe(source: string): Promise<SourceInfo> {
    const { stdout } = await this.run(
      path.join(this.runtime, "bin/ffprobe"),
      ["-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,pix_fmt,color_transfer,r_frame_rate,avg_frame_rate:stream_side_data:stream_tags=rotate:format=duration",
        "-of", "json", source],
      "GIF 변환 · 영상 정보 확인",
    );
    const parsed = JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { duration?: string } };
    const stream = parsed.streams?.[0];
    if (!stream) throw new Error("GIF_SOURCE: 영상 트랙을 찾지 못했어요.");
    return sourceInfo(stream, Number(parsed.format?.duration));
  }

  private async convertNow(raw: unknown): Promise<GifConvertResult> {
    const began = performance.now();
    const input = gifConvertInput.parse(raw);
    const source = await realpath(input.sourcePath).catch(() => {
      throw new Error("GIF_SOURCE: 원본 영상을 찾지 못했어요.");
    });
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("GIF_SOURCE: 원본은 일반 파일이어야 해요.");
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase()))
      throw new Error("GIF_SOURCE: mov/mp4/m4v 영상만 변환해요.");
    const output = path.resolve(input.outputPath);
    const directory = await realpath(path.dirname(output)).catch(() => {
      throw new Error("GIF_OUTPUT: 저장할 폴더가 없어요.");
    });
    const target = path.join(directory, path.basename(output));
    if (target === source) throw new Error("GIF_OUTPUT: 원본을 덮어쓸 수 없어요.");
    const existing = await stat(target).catch(() => undefined);
    if (existing && (!input.overwrite || !existing.isFile()))
      throw new Error("GIF_OUTPUT_EXISTS: 같은 이름의 파일이 있어요. overwrite를 켜거나 다른 경로를 지정해주세요.");

    const info = await this.probe(source);
    const range = clampRange(info, input.start ?? 0, input.end, GIF_MAX_SECONDS);
    const dither = input.dither ?? "bayer";
    // Validates the crop against the real frame before any encoding.
    const crop = input.crop ? { ...input.crop, pixels: cropPixels(info, input.crop) } : null;
    let route: Route = gpuSupported(info) ? "videotoolbox" : "cpu";
    let settings = { width: input.width ?? GIF_DEFAULT_WIDTH, fps: input.fps ?? GIF_DEFAULT_FPS };
    const attempts: GifAttempt[] = [];
    const warnings: string[] = [];
    const work = await mkdtemp(path.join(os.tmpdir(), "reels-gif-"));
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.partial`);
    try {
      for (;;) {
        const size = frameSize(info, settings.width, input.crop);
        const fps = outputFps(info, settings.fps);
        const encode = async (via: Route) => {
          const palette = path.join(work, `palette-${attempts.length}.png`);
          await this.run(path.join(this.runtime, "bin/ffmpeg"), paletteArgs(via, source, info, range, size, fps, palette), "GIF 변환 · 팔레트");
          await this.run(path.join(this.runtime, "bin/ffmpeg"), encodeArgs(via, source, info, range, size, fps, dither, palette, temporary), "GIF 변환 · 인코딩");
        };
        try {
          await encode(route);
        } catch (error) {
          if (route !== "videotoolbox") throw error;
          // Same policy as the playback proxy: GPU first, CPU decode/filters as fallback.
          warnings.push(`GPU 경로 실패로 CPU 경로를 사용했어요: ${lastLine(error)}`);
          route = "cpu";
          await encode(route);
        }
        const bytes = (await stat(temporary)).size;
        attempts.push({ width: size.width, height: size.height, fps, bytes });
        const next = input.maxBytes && bytes > input.maxBytes ? nextAttempt({ width: size.width, fps }, bytes, input.maxBytes) : undefined;
        if (!next || attempts.length >= 4) break;
        settings = next;
      }
      const last = attempts.at(-1)!;
      if (input.maxBytes && last.bytes > input.maxBytes)
        warnings.push(`요청한 최대 크기 ${MB(input.maxBytes)}보다 커요(${MB(last.bytes)}). start/end로 구간을 줄이거나 width를 더 낮춰주세요.`);
      if (last.bytes > GIF_SIZE_WARNING_BYTES)
        warnings.push(`${MB(last.bytes)}로 네이버 블로그 GIF 상한 추정치 20MB를 넘어요(공식 상한 미확인). maxBytes를 지정하면 fps·width를 자동으로 낮춰요.`);
      await rename(temporary, target);
      return {
        // As requested (folder symlinks such as /var -> /private/var are kept).
        outputPath: output,
        bytes: last.bytes,
        width: last.width,
        height: last.height,
        fps: last.fps,
        frames: Math.max(1, Math.round(range.duration * last.fps)),
        durationSeconds: round(range.duration),
        start: round(range.start),
        end: round(range.end),
        sourceDurationSeconds: round(info.duration),
        elapsedMs: Math.round(performance.now() - began),
        accel: route,
        hdrToSDR: info.hdr,
        rotation: info.rotation,
        crop,
        dither,
        loop: "infinite",
        audio: "removed",
        metadata: "removed",
        attempts,
        warnings,
      };
    } finally {
      await rm(temporary, { force: true });
      await rm(work, { recursive: true, force: true });
    }
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;
function lastLine(error: unknown) {
  const text = String((error as { stderr?: string })?.stderr || (error as Error)?.message || error).trim();
  return text.split("\n").at(-1)?.slice(0, 300) ?? "";
}
