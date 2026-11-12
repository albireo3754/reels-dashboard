/**
 * Pure planning for the video -> GIF conversion: probe interpretation, sizes, the
 * ffmpeg filter graphs and the size-fitting ladder. No process or file access here.
 */

export interface ProbeStream {
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_transfer?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  side_data_list?: Array<Record<string, unknown>>;
  tags?: Record<string, string>;
}
export interface SourceInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hdr: boolean;
  /** Clockwise display rotation in degrees, 0/90/180/270 (or another value when unusual). */
  rotation: number;
  mirrored: boolean;
  /** Bit depth above 8 decodes to p010 VideoToolbox frames. */
  highBitDepth: boolean;
}

const rate = (value?: string) => {
  const [n, d] = String(value ?? "").split("/").map(Number);
  return n > 0 && d > 0 ? n / d : 0;
};

/** Same reading as the editor engine's display_rotation (ffprobe display matrix). */
export function displayRotation(stream: ProbeStream): { rotation: number; mirrored: boolean } {
  for (const item of stream.side_data_list ?? []) {
    if (!("rotation" in item)) continue;
    const values = String(item.displaymatrix ?? "")
      .split("\n")
      .filter((line) => line.includes(":"))
      .flatMap((line) => line.split(":", 2)[1].trim().split(/\s+/).map(Number));
    const mirrored = values.length >= 5 && values[0] * values[4] - values[1] * values[3] < 0;
    return { rotation: mod360(Math.round(Number(item.rotation))), mirrored };
  }
  return { rotation: mod360(Math.round(Number(stream.tags?.rotate ?? 0))), mirrored: false };
}
const mod360 = (value: number) => (Number.isFinite(value) ? ((value % 360) + 360) % 360 : 0);

export function sourceInfo(stream: ProbeStream, duration: number): SourceInfo {
  const width = Number(stream.width), height = Number(stream.height);
  if (!(width > 0 && height > 0)) throw new Error("GIF_SOURCE: 영상 트랙을 찾지 못했어요.");
  if (!(Number.isFinite(duration) && duration > 0))
    throw new Error("GIF_SOURCE: 영상 길이를 읽지 못했어요.");
  const { rotation, mirrored } = displayRotation(stream);
  return {
    width,
    height,
    duration,
    fps: rate(stream.avg_frame_rate) || rate(stream.r_frame_rate) || 30,
    hdr: ["arib-std-b67", "smpte2084"].includes(stream.color_transfer ?? ""),
    rotation,
    mirrored,
    highBitDepth: /(p10|p12|p16|10le|12le|10be|12be)/.test(stream.pix_fmt ?? ""),
  };
}

/** Display size after rotation. */
export function displaySize(info: SourceInfo) {
  return info.rotation === 90 || info.rotation === 270
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height };
}

/** Even output size of the requested width keeping the display aspect, never upscaled. */
export function outputSize(info: SourceInfo, requested: number) {
  const display = displaySize(info);
  const width = Math.max(2, Math.floor(Math.min(requested, display.width) / 2) * 2);
  const height = Math.max(2, Math.round((display.height * width) / display.width / 2) * 2);
  return { width, height };
}

export interface CropFraction {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * Output frame size plus, when cropping, how to get there: scale the whole displayed frame
 * to `scaled` (GPU), then cut `width`x`height` at (`x`, `y`) out of it (CPU, already small).
 */
export interface FrameSize {
  width: number;
  height: number;
  crop?: { scaledWidth: number; scaledHeight: number; x: number; y: number };
}
/** Below this the source rectangle is too small to be a useful GIF. */
export const MIN_CROP_PIXELS = 16;
const even = (value: number) => Math.round(value / 2) * 2;

/** Kept rectangle in displayed source pixels. */
export function cropPixels(info: SourceInfo, crop: CropFraction) {
  const display = displaySize(info);
  const x = Math.round(display.width * crop.x), y = Math.round(display.height * crop.y);
  const width = Math.min(display.width - x, Math.round(display.width * crop.width));
  const height = Math.min(display.height - y, Math.round(display.height * crop.height));
  if (width < MIN_CROP_PIXELS || height < MIN_CROP_PIXELS)
    throw new Error(`GIF_CROP: 잘라낸 영역이 너무 작아요(${width}×${height}px). 가로·세로 ${MIN_CROP_PIXELS}px 이상이어야 해요.`);
  return { x, y, width, height };
}

/**
 * Even output size of the requested width keeping the cropped aspect, never upscaled.
 * The crop offsets are even so 4:2:0 chroma lines up and both routes cut the same pixels.
 */
export function frameSize(info: SourceInfo, requested: number, crop?: CropFraction): FrameSize {
  if (!crop) return outputSize(info, requested);
  const display = displaySize(info);
  const rect = cropPixels(info, crop);
  const width = Math.max(2, Math.floor(Math.min(requested, rect.width) / 2) * 2);
  const scale = width / rect.width;
  const height = Math.max(2, even(rect.height * scale));
  const scaledWidth = Math.max(width, even(display.width * scale));
  const scaledHeight = Math.max(height, even(display.height * scale));
  const clamp = (value: number, max: number) => Math.min(Math.max(0, even(value)), max);
  return {
    width,
    height,
    crop: {
      scaledWidth,
      scaledHeight,
      x: clamp(rect.x * scale, scaledWidth - width),
      y: clamp(rect.y * scale, scaledHeight - height),
    },
  };
}

export function outputFps(info: SourceInfo, requested: number) {
  return Math.max(1, Math.min(requested, Math.round(info.fps)));
}

export function clampRange(info: SourceInfo, start = 0, end?: number, maxSeconds = 60) {
  if (start >= info.duration)
    throw new Error(`GIF_RANGE: 시작(${start}초)이 영상 길이(${round(info.duration)}초)를 넘어요.`);
  const stop = Math.min(end ?? info.duration, info.duration);
  if (stop - start > maxSeconds + 1e-6)
    throw new Error(
      `GIF_RANGE: GIF는 최대 ${maxSeconds}초까지 만들어요. start/end로 구간을 지정해주세요(요청 ${round(stop - start)}초).`,
    );
  return { start, end: stop, duration: stop - start };
}
const round = (v: number) => Math.round(v * 100) / 100;

const GPU_ROTATION: Record<number, string> = {
  90: "transpose_vt=dir=cclock",
  180: "transpose_vt=dir=reversal",
  270: "transpose_vt=dir=clock",
};
const CPU_ROTATION: Record<number, string> = {
  90: "transpose=cclock",
  180: "hflip,vflip",
  270: "transpose=clock",
};

export type Route = "videotoolbox" | "cpu";
export function gpuSupported(info: SourceInfo) {
  return !info.mirrored && (info.rotation === 0 || info.rotation in GPU_ROTATION);
}

/**
 * Frame filters up to 8-bit-or-better software frames at the output size.
 *
 * videotoolbox: decoder frames stay on the GPU through transpose_vt and scale_vt; scale_vt
 * also performs the HDR -> BT.709 conversion (same as the playback proxy), then hwdownload.
 * A crop scales the whole frame on the GPU to the size where the kept area is the output
 * size, and cuts it right after hwdownload, so the CPU only copies output-sized lines.
 * cpu: autorotated software frames, lanczos scale, zscale/hable tone mapping for HDR; a crop
 * cuts the same rectangle at the same point (after scaling, before tone mapping).
 */
export function frameFilters(route: Route, info: SourceInfo, size: FrameSize, fps: number) {
  const scaled = size.crop ? { width: size.crop.scaledWidth, height: size.crop.scaledHeight } : size;
  const cut = size.crop ? [`crop=${size.width}:${size.height}:${size.crop.x}:${size.crop.y}:exact=1`] : [];
  if (route === "videotoolbox") {
    let scale = `scale_vt=w=${scaled.width}:h=${scaled.height}`;
    if (info.hdr) scale += ":color_matrix=bt709:color_primaries=bt709:color_transfer=bt709";
    return [
      `fps=${fps}`,
      ...(info.rotation ? [GPU_ROTATION[info.rotation]] : []),
      scale,
      "hwdownload",
      `format=${info.highBitDepth ? "p010le" : "nv12"}`,
      ...cut,
    ].join(",");
  }
  const filters = [`fps=${fps}`];
  // The CPU route keeps ffmpeg's autorotation off too so both routes read the same matrix.
  if (info.mirrored || (info.rotation && !(info.rotation in CPU_ROTATION)))
    throw new Error("GIF_SOURCE: 반전되었거나 직각이 아닌 회전 영상은 지원하지 않아요.");
  if (info.rotation) filters.push(CPU_ROTATION[info.rotation]);
  filters.push(`scale=${scaled.width}:${scaled.height}:flags=lanczos`, ...cut);
  if (info.hdr)
    filters.push(
      "zscale=t=linear:npl=100",
      "format=gbrpf32le",
      "tonemap=tonemap=hable:desat=0",
      "zscale=p=bt709:t=bt709:m=bt709:r=tv",
    );
  filters.push("format=yuv420p");
  return filters.join(",");
}

export function inputArgs(route: Route, source: string, range: { start: number; duration: number }) {
  return [
    ...(route === "videotoolbox"
      ? ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"]
      : []),
    "-noautorotate",
    ...(range.start > 0 ? ["-ss", String(range.start)] : []),
    "-t",
    String(range.duration),
    "-i",
    source,
  ];
}

/** Palette frames per second: about 48 samples over the range, never more than the GIF rate. */
export function paletteFps(duration: number, fps: number) {
  return Math.max(1, Math.min(fps, Math.ceil(48 / Math.max(duration, 0.1))));
}

/** Pass 1: one global palette from sampled frames (palettegen over every frame is the slow part). */
export function paletteArgs(route: Route, source: string, info: SourceInfo, range: { start: number; duration: number }, size: FrameSize, fps: number, palette: string) {
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    ...inputArgs(route, source, range),
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", `${frameFilters(route, info, size, paletteFps(range.duration, fps))},palettegen=stats_mode=full`,
    "-frames:v", "1", "-update", "1",
    palette,
  ];
}

export const DITHER = { bayer: "bayer:bayer_scale=3", smooth: "sierra2_4a" } as const;

/** Pass 2: every frame mapped to the palette; no audio, no metadata, loops forever. */
export function encodeArgs(route: Route, source: string, info: SourceInfo, range: { start: number; duration: number }, size: FrameSize, fps: number, dither: keyof typeof DITHER, palette: string, output: string) {
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    ...inputArgs(route, source, range),
    "-i", palette,
    "-filter_complex",
    `[0:v:0]${frameFilters(route, info, size, fps)}[v];[v][1:v]paletteuse=dither=${DITHER[dither]}:diff_mode=rectangle[out]`,
    "-map", "[out]", "-an", "-sn", "-dn",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-loop", "0",
    "-f", "gif",
    output,
  ];
}

/**
 * Settings to try when a GIF exceeds maxBytes: lower fps first (motion stays readable),
 * then narrower frames. Returns undefined when nothing smaller is left.
 */
export function nextAttempt(current: { width: number; fps: number }, bytes: number, maxBytes: number) {
  const ratio = maxBytes / bytes;
  if (current.fps > 10) {
    // GIF bytes scale roughly with frame count.
    const fps = Math.max(10, Math.min(current.fps - 2, Math.floor(current.fps * ratio * 0.95)));
    return { width: current.width, fps };
  }
  if (current.width > 240) {
    // ...and roughly with pixel count.
    const width = Math.max(240, Math.min(current.width - 40, Math.floor((current.width * Math.sqrt(ratio * 0.95)) / 2) * 2));
    return { width, fps: current.fps };
  }
  return undefined;
}
