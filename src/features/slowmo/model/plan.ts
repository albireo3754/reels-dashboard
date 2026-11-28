import {
  SLOWMO_DEFAULT_SPEED,
  SLOWMO_MAX_OUTPUT_SECONDS,
  SLOWMO_MAX_SOURCE_SECONDS,
  type SlowmoStartInput,
} from "../../../shared/slowmo";

export interface Probe {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hdr: boolean;
  hasAudio: boolean;
}

export interface Plan {
  start: number;
  end: number;
  speed: number;
  fps: number;
  outputSeconds: number;
  warnings: string[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Pure validation of the requested range, speed and frame rate against the probed source. */
export function plan(probe: Probe, input: Pick<SlowmoStartInput, "start" | "end" | "speed" | "fps">): Plan {
  if (!(probe.duration > 0)) throw new Error("SLOWMO_SOURCE: 영상 길이를 확인하지 못했어요.");
  const start = input.start ?? 0;
  if (start >= probe.duration)
    throw new Error(`SLOWMO_RANGE: 시작 ${start}초가 영상 길이(${round(probe.duration)}초)를 벗어나요.`);
  const end = Math.min(input.end ?? probe.duration, probe.duration);
  if (end - start > SLOWMO_MAX_SOURCE_SECONDS + 1e-6)
    throw new Error(`SLOWMO_RANGE: 한 번에 원본 ${SLOWMO_MAX_SOURCE_SECONDS}초까지 처리해요. start/end로 구간을 줄여주세요.`);
  const speed = input.speed ?? SLOWMO_DEFAULT_SPEED;
  const sourceFps = probe.fps > 0 ? probe.fps : 30;
  const fps = input.fps ?? Math.min(60, Math.max(24, Math.round(sourceFps)));
  const outputSeconds = (end - start) / speed;
  if (outputSeconds > SLOWMO_MAX_OUTPUT_SECONDS)
    throw new Error(`SLOWMO_RANGE: 결과가 ${SLOWMO_MAX_OUTPUT_SECONDS}초를 넘어요(${Math.round(outputSeconds)}초). 구간을 줄이거나 speed를 높여주세요.`);
  const warnings: string[] = [];
  if (input.end !== undefined && input.end > probe.duration)
    warnings.push(`끝 ${input.end}초가 영상 길이보다 길어서 ${round(probe.duration)}초까지 처리했어요.`);
  if (sourceFps >= fps / speed - 0.5)
    warnings.push(`원본이 ${round(sourceFps)}fps라 ${speed}배 속도에서도 새 프레임이 거의 필요 없어요. 보간 없이도 부드러운 원본이에요.`);
  if (probe.hasAudio) warnings.push("소리는 넣지 않았어요. 음악은 편집에서 따로 넣어주세요.");
  return { start: round(start), end: round(end), speed, fps, outputSeconds: round(outputSeconds), warnings };
}
