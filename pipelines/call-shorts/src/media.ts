import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import type { MediaInfo } from "./types.js";

export class FfmpegError extends Error {
  readonly hint = "macOS: brew install ffmpeg";
}

export function which(binary: string): string | null {
  if (binary.includes(path.sep)) return existsSync(binary) ? binary : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveFfmpeg(config?: Config): string | null {
  if (config?.ffmpegBin) return config.ffmpegBin;
  return which("ffmpeg");
}

export function resolveFfprobe(config?: Config): string | null {
  if (config?.ffprobeBin) return config.ffprobeBin;
  return which("ffprobe");
}

export function requireFfmpeg(config?: Config): string {
  const binary = resolveFfmpeg(config);
  if (!binary) throw new FfmpegError("ffmpeg를 찾을 수 없습니다.");
  return binary;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  check?: boolean;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 3_600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    throw new Error(`명령 실행 실패 (${cmd}): ${result.error.message}`);
  }
  const status = result.status ?? 1;
  if (options.check !== false && status !== 0) {
    const tail = stderr.trim().split("\n").slice(-10).join("\n");
    throw new Error(`명령 실패 (exit ${status}): ${cmd} ${args.slice(0, 4).join(" ")} …\n${tail}`);
  }
  return { status, stdout, stderr };
}

export function ffmpegVersion(config?: Config): string | null {
  const binary = resolveFfmpeg(config);
  if (!binary) return null;
  const result = run(binary, ["-version"], { check: false });
  return result.stdout.split("\n")[0]?.trim() ?? null;
}

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const SIZE_RE = /(\d{2,5})x(\d{2,5})/;
const FPS_RE = /([\d.]+)\s+fps/;

function parseFfmpegStderr(text: string): MediaInfo {
  const info: MediaInfo = { durationSec: null, width: null, height: null, fps: null, hasAudio: false };
  const match = DURATION_RE.exec(text);
  if (match) {
    info.durationSec = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  for (const line of text.split("\n")) {
    if (line.includes("Video:")) {
      const size = SIZE_RE.exec(line);
      if (size) {
        info.width = Number(size[1]);
        info.height = Number(size[2]);
      }
      const fps = FPS_RE.exec(line);
      if (fps) info.fps = Number(fps[1]);
      break;
    }
  }
  info.hasAudio = text.includes("Audio:");
  return info;
}

export function probeMedia(file: string, config?: Config): MediaInfo {
  const ffprobe = resolveFfprobe(config);
  if (ffprobe) {
    const probe = run(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { check: false },
    );
    if (probe.status === 0) {
      try {
        const data = JSON.parse(probe.stdout) as {
          format?: { duration?: string };
          streams?: Array<Record<string, unknown>>;
        };
        const info: MediaInfo = { durationSec: null, width: null, height: null, fps: null, hasAudio: false };
        const duration = Number(data.format?.duration);
        info.durationSec = Number.isFinite(duration) ? duration : null;
        for (const stream of data.streams ?? []) {
          if (stream.codec_type === "video" && info.width === null) {
            info.width = Number(stream.width) || null;
            info.height = Number(stream.height) || null;
            const rate = String(stream.avg_frame_rate ?? stream.r_frame_rate ?? "0/1");
            const [numText, denText] = rate.split("/");
            const fps = Number(numText) / Number(denText || 1);
            info.fps = Number.isFinite(fps) ? Number(fps.toFixed(3)) : null;
          }
          if (stream.codec_type === "audio") info.hasAudio = true;
        }
        return info;
      } catch {
      }
    }
  }
  const binary = requireFfmpeg(config);
  const result = run(binary, ["-hide_banner", "-i", file], { check: false });
  return parseFfmpegStderr(result.stderr + result.stdout);
}
