import { z } from "zod";
import { absolutePathSchema } from "./path-schema";

/**
 * Slow motion with GPU optical-flow frame interpolation (native `reels-slowmo`).
 *
 * Slowing a 30 fps clip to 0.5x without new frames plays each frame twice and looks
 * choppy. The tool estimates motion between neighbouring frames (Apple Vision) and
 * draws the in-between frames on the GPU (Metal), then hardware-encodes the result.
 */
export const SLOWMO_DEFAULT_SPEED = 0.5;
/** Longer source ranges take minutes and are rarely useful as one slow shot. */
export const SLOWMO_MAX_SOURCE_SECONDS = 60;
export const SLOWMO_MAX_OUTPUT_SECONDS = 600;
/** Optical flow runs on frames scaled to this long side; full-HD sources are unchanged. */
export const SLOWMO_FLOW_LONG_SIDE = 1920;

const absolutePath = absolutePathSchema("NUL is not allowed");
const seconds = z.number().finite().min(0).max(86400);

export const slowmoStartInput = z
  .strictObject({
    sourcePath: absolutePath.describe("Video file (mov/mp4/m4v). Never modified."),
    outputPath: absolutePath
      .refine((v) => /\.(mov|mp4)$/i.test(v), "outputPath must end with .mov or .mp4")
      .describe("New .mov or .mp4 path in an existing folder. Must differ from the source."),
    start: seconds.optional().describe("Source range start in seconds. Default 0."),
    end: seconds.optional().describe(`Source range end in seconds. Default: end of the video. At most ${SLOWMO_MAX_SOURCE_SECONDS} s of source.`),
    speed: z
      .number()
      .finite()
      .min(0.1)
      .max(0.9)
      .optional()
      .describe(`Playback speed of the result relative to the source. Default ${SLOWMO_DEFAULT_SPEED} (half speed); 0.25 = quarter speed.`),
    fps: z
      .number()
      .int()
      .min(24)
      .max(120)
      .optional()
      .describe("Output frames per second. Default: the source rate rounded, at most 60 (30 for iPhone 30 fps clips)."),
    overwrite: z.boolean().optional().describe("Replace an existing file at outputPath. Default false."),
  })
  .refine((v) => v.end === undefined || v.end > (v.start ?? 0), {
    message: "end must be greater than start",
    path: ["end"],
  });
export type SlowmoStartInput = z.infer<typeof slowmoStartInput>;

export const slowmoJobInput = z.strictObject({ jobId: z.string().min(1).max(200) });

export interface SlowmoResult {
  outputPath: string;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  speed: number;
  /** Seconds of the result. */
  durationSeconds: number;
  start: number;
  end: number;
  sourceDurationSeconds: number;
  sourceFps: number;
  frames: number;
  /** Frames drawn between source frames (the rest are source frames passed through the same GPU path). */
  interpolatedFrames: number;
  /** HDR sources stay HDR (HEVC Main10 with the source transfer); SDR is H.264. */
  hdr: boolean;
  codec: "h264" | "hevc-main10";
  elapsedMs: number;
  audio: "removed";
  warnings: string[];
}

export type SlowmoJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface SlowmoJob {
  id: string;
  sourcePath: string;
  outputPath: string;
  state: SlowmoJobState;
  percent: number;
  createdAt: string;
  finishedAt?: string;
  result?: SlowmoResult;
  error?: string;
}

export interface SlowmoBridge {
  start(input: unknown): Promise<SlowmoJob>;
  get(jobId: string): SlowmoJob;
  cancel(jobId: string): Promise<SlowmoJob>;
}
