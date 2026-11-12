import { z } from "zod";
import { absolutePathSchema } from "./path-schema";

/**
 * Silent, endlessly looping GIF made from a video (blog motion clips).
 *
 * Naver Blog's GIF upload limit is not officially documented; 20 MB is the commonly
 * reported figure and is used here only as a warning threshold, never as a hard limit.
 */
export const GIF_SIZE_WARNING_BYTES = 20 * 1024 * 1024;
export const GIF_DEFAULT_WIDTH = 480;
export const GIF_DEFAULT_FPS = 15;
/** Longer ranges make GIFs too large to be useful and outlast the agent socket timeout. */
export const GIF_MAX_SECONDS = 60;

const absolutePath = absolutePathSchema("NUL is not allowed");
const seconds = z.number().finite().min(0).max(86400);
/** Allow tiny float noise such as 0.15 + 0.85. */
const EDGE = 1e-6;

/** Fractions of the displayed frame (after rotation), origin at the top-left. */
export const gifCrop = z
  .strictObject({
    x: z.number().finite().min(0).lt(1).describe("Left edge, 0-1 of the displayed width."),
    y: z.number().finite().min(0).lt(1).describe("Top edge, 0-1 of the displayed height."),
    width: z.number().finite().gt(0).max(1).describe("Kept width, 0-1 of the displayed width."),
    height: z.number().finite().gt(0).max(1).describe("Kept height, 0-1 of the displayed height."),
  })
  .refine((v) => v.x + v.width <= 1 + EDGE, { message: "x + width must be at most 1", path: ["width"] })
  .refine((v) => v.y + v.height <= 1 + EDGE, { message: "y + height must be at most 1", path: ["height"] });
export type GifCrop = z.infer<typeof gifCrop>;

export const gifConvertInput = z
  .strictObject({
    sourcePath: absolutePath.describe("Video file (mov/mp4/m4v). Never modified."),
    outputPath: absolutePath
      .refine((v) => /\.gif$/i.test(v), "outputPath must end with .gif")
      .describe("New .gif path in an existing folder. Must differ from the source."),
    start: seconds.optional().describe("Range start in seconds. Default 0."),
    end: seconds
      .optional()
      .describe("Range end in seconds. Default: end of the video (whole length)."),
    crop: gifCrop
      .optional()
      .describe(
        'Keep only this part of the displayed (rotated) frame, as 0-1 fractions. Example: drop the top 15% = {"x":0,"y":0.15,"width":1,"height":0.85}. width/fps/maxBytes then apply to the cropped area. Default: whole frame.',
      ),
    width: z
      .number()
      .int()
      .min(120)
      .max(1080)
      .optional()
      .describe(`Output width in pixels after rotation and crop. Default ${GIF_DEFAULT_WIDTH}; never upscaled.`),
    fps: z
      .number()
      .int()
      .min(5)
      .max(30)
      .optional()
      .describe(`Frames per second. Default ${GIF_DEFAULT_FPS}; capped at the source rate.`),
    dither: z
      .enum(["bayer", "smooth"])
      .optional()
      .describe(
        "bayer (default): ordered dither, fastest and smallest. smooth: error diffusion for soft gradients; about 2-3x slower and ~20% larger.",
      ),
    maxBytes: z
      .number()
      .int()
      .min(256 * 1024)
      .max(200 * 1024 * 1024)
      .optional()
      .describe(
        "If set and the GIF is larger, retry with lower fps, then smaller width (up to 4 attempts) and report each attempt.",
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace an existing GIF at outputPath. Default false."),
  })
  .refine((v) => v.end === undefined || v.end > (v.start ?? 0), {
    message: "end must be greater than start",
    path: ["end"],
  });
export type GifConvertInput = z.infer<typeof gifConvertInput>;

export interface GifAttempt {
  width: number;
  height: number;
  fps: number;
  bytes: number;
}
export interface GifConvertResult {
  outputPath: string;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Seconds of video in the GIF. */
  durationSeconds: number;
  start: number;
  end: number;
  sourceDurationSeconds: number;
  /** Wall-clock conversion time including every attempt. */
  elapsedMs: number;
  /** videotoolbox: GPU decode, rotation, HDR->SDR and scaling. cpu: software fallback. */
  accel: "videotoolbox" | "cpu";
  hdrToSDR: boolean;
  rotation: number;
  /** Crop as requested plus the kept rectangle in displayed source pixels; null when not cropped. */
  crop: (GifCrop & { pixels: { x: number; y: number; width: number; height: number } }) | null;
  dither: "bayer" | "smooth";
  loop: "infinite";
  audio: "removed";
  metadata: "removed";
  attempts: GifAttempt[];
  warnings: string[];
}
export interface GifConvertBridge {
  convert(input: GifConvertInput): Promise<GifConvertResult>;
}
