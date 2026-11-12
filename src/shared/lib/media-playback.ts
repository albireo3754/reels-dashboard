import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Playback policy shared by the board viewer and the editor: originals stream as
 * they are (HDR included). A playback copy is made only when the renderer reports
 * that it cannot decode the original, or when the original is an iCloud
 * placeholder whose bytes are not on this Mac.
 */
export type PlaybackMode = "original" | "copy";

/** macOS `SF_DATALESS` (sys/stat.h): the file's contents live only in the cloud. */
export const SF_DATALESS = 0x40000000;

export function videoContentType(file: string) {
  return (
    { ".mov": "video/quicktime", ".webm": "video/webm" }[
      path.extname(file).toLowerCase()
    ] ?? "video/mp4"
  );
}

export const hasDatalessFlag = (flags: number) =>
  Number.isSafeInteger(flags) && flags >= 0 && (flags & SF_DATALESS) !== 0;

/** Reads `st_flags` with the system stat tool; Node's fs.Stats does not expose it. */
export function readFileFlags(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/stat",
      ["-f", "%f", file],
      { timeout: 5_000, maxBuffer: 1024 },
      (error, stdout) => {
        const flags = Number(String(stdout).trim());
        resolve(error || !/^\d+$/.test(String(stdout).trim()) ? null : flags);
      },
    );
  });
}

/**
 * True when the file is an evicted (dataless) iCloud placeholder. The st_flags bit
 * is authoritative; `blocks === 0 && size > 0` is used only when the flags cannot be
 * read. Reading neither triggers a download. Any failure counts as local, so the
 * original is played directly.
 */
export async function isDatalessFile(
  file: string,
  options: {
    platform?: NodeJS.Platform;
    readFlags?: (file: string) => Promise<number | null>;
    info?: { size: number; blocks: number };
  } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  try {
    const flags = await (options.readFlags ?? readFileFlags)(file);
    if (flags !== null) return hasDatalessFlag(flags);
  } catch {
    /* Fall through to the block-count heuristic. */
  }
  try {
    const info = options.info ?? (await stat(file));
    return info.size > 0 && info.blocks === 0;
  } catch {
    return false;
  }
}
