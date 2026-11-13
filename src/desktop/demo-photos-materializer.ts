import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

interface DemoAsset {
  id: string;
  mediaKind: "photo" | "video";
  publicFilename?: string | null;
}

/**
 * REELS_DEMO stand-in for native `media.materialize`: writes synthetic media
 * into the same private `native/editor-sources/<UUID>/` layout so QA exercises
 * the bundle import without a Photos library. Demo asset 2 acts as a Live Photo.
 */
export function demoMaterializer(options: {
  supportRoot: string;
  ffmpeg: string;
  assets: () => Promise<DemoAsset[]>;
}) {
  const ffmpeg = (args: string[]) =>
    run(options.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const video = (file: string, seconds: number) =>
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24",
      "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", file,
    ]);
  return async (selection: { assetID: string }) => {
    const asset = (await options.assets()).find((a) => a.id === selection.assetID);
    if (!asset) throw new Error("editor-asset-not-in-group: Select an asset from the current group.");
    const dir = path.join(options.supportRoot, "editor-sources", randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stem = path.parse(asset.publicFilename || asset.id).name;
    if (asset.mediaKind === "video") {
      const sourcePath = path.join(dir, `${stem}.mp4`);
      await video(sourcePath, 1);
      return { assetID: asset.id, mediaKind: asset.mediaKind, sourcePath, originalFilename: asset.publicFilename ?? null };
    }
    const sourcePath = path.join(dir, `${stem}.jpg`);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=720x960", "-frames:v", "1", sourcePath]);
    let pairedVideoPath: string | null = null;
    if (asset.id === "demo-asset-2") {
      pairedVideoPath = path.join(dir, `${stem}-live.mov`);
      await video(pairedVideoPath, 1);
    }
    return { assetID: asset.id, mediaKind: asset.mediaKind, sourcePath, pairedVideoPath, originalFilename: asset.publicFilename ?? null };
  };
}
