import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BudgetGuard } from "./budget.js";
import type { Config } from "./config.js";
import { MAX_CAPTION_CHARS, saveEpisode, saveValidationErrors, totalDuration, validateEpisode } from "./episode.js";
import { BudgetExceededError, NeedsHumanError } from "./errors.js";
import { callAnthropic, callOpenAI, stripFence, type TextClient, type TextRequest } from "./providers.js";
import { redactEpisode } from "./redact.js";
import type { StateStore } from "./state.js";
import { planningText } from "./transcribe.js";
import type { Episode, EpisodeCut, PlatformMeta, Transcript } from "./types.js";

export const HOOK_SYSTEM = `너는 한국 커플 일상 숏폼(35~45초)의 훅 카피라이터다.
실제 커플의 통화 전사문에서 첫 3초에 스크롤을 멈추게 할 문장만 뽑는다.
과장된 낚시는 금지하고, 전사문에 실제로 있는 말로만 만든다.`;

export const EPISODE_SYSTEM = `너는 한국 숏폼 편집자다. 주어진 훅·비트와 전사문을 방송용 episode.json으로 변환한다.
JSON 외의 텍스트를 출력하지 않는다. 자막은 실제 발화를 그대로 인용한다.`;

export function buildHookPrompt(transcript: string): string {
  return `아래는 실제 커플 통화 전사문이다. 목표: 35~45초 숏폼에서 첫 3초에 스크롤을 멈추게 할 훅 5개.

규칙
- 5개는 서로 다른 심리축이어야 한다: ①충격 인용 ②공감 자기투영 ③의문 갭 ④숫자/금액 ⑤배신·반전 예고
- 각 훅은 22자 이내, 구어체, 설명 금지. "~했는데" 식 상황 설명은 3순위.
- 각 훅마다 (a) 첫 프레임에 무엇이 보여야 하는지 한 줄 (b) 이 훅이 약속하는 보상이 이 통화의
  어느 구간(타임스탬프)에서 회수되는지 반드시 적어라.
- 회수 구간이 없는 훅은 후보에서 버려라.
- 실명·회사명·지명은 쓰지 말고 일반화하라.

출력: 마크다운 표 5행 (훅 | 심리축 | 첫 프레임 | 회수 구간) + 마지막에 추천 1개와 이유 2줄.
전사문:
<<<
${transcript.trim().slice(0, 24000)}
>>>`;
}

export function buildEpisodePrompt(hooks: string, transcript: string, durationSec: number): string {
  return `아래 기획안과 전사문으로 세로 숏폼(9:16, 30fps) 편집본 episode.json을 만들어라.

[스키마 규칙 — 반드시 지켜라]
- cuts는 5~8개. 각 컷은 새 정보 1개. 자막 중복 금지.
- 자막(caption)은 한 줄 14자 이내, 최대 2줄. 실제 발화를 그대로 인용한다(요약·번역 금지).
- 컷 길이(tEnd - tStart)는 자막 글자수 ÷ 9 이상이어야 한다.
- 첫 컷은 0.0초에서 시작하고, 이전 컷의 tEnd와 다음 컷의 tStart가 정확히 이어진다.
- 첫 컷의 sourceRange는 실제 발화 구간이고, caption은 그 발화에서 나온 말이어야 한다.
- sourceRange는 [통화 시작 기준 초, 끝 초]. 길이는 컷 길이 이상이어야 한다.
- speaker는 "GF"(여자) 또는 "BF"(남자)만.
- 전체 길이는 25~55초(targetDurationSec는 35~45 권장).
- visual.scene은 한국어 한 문장, emotion은 한 단어, props는 배열.
- 이미지에는 글자를 넣지 않는다(자막은 후반 합성). 실제 인물을 닮게 그리는 표현 금지.
- aiDisclosure: 손그림 일러스트 + 실제 통화 음성이면 3사 모두 false, reason에 근거 한 문장.
- platformMeta: youtube/instagram/tiktok 각각 title·caption + 해시태그 5개 이하.

[기획안 hooks.md]
<<<
${hooks.trim().slice(0, 8000)}
>>>

[전사문]
<<<
${transcript.trim().slice(0, 24000)}
>>>

[통화 길이]
${durationSec.toFixed(1)}초`;
}

export function buildRepairPrompt(issues: string[], episode: unknown, transcript: string): string {
  return `아래 episode.json이 검증 규칙을 통과하지 못했다. 규칙을 지켜 전체 JSON을 다시 출력하라.

[검증 오류]
${issues.map((issue) => `- ${issue}`).join("\n")}

[이전 JSON]
<<<
${JSON.stringify(episode).slice(0, 12000)}
>>>

[전사문]
<<<
${transcript.trim().slice(0, 16000)}
>>>`;
}

export const EPISODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "episodeId",
    "source",
    "format",
    "targetDurationSec",
    "hook",
    "cuts",
    "punchline",
    "loop",
    "redactions",
    "aiDisclosure",
    "platformMeta",
  ],
  properties: {
    episodeId: { type: "string" },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["audio", "durationSec", "callDate"],
      properties: { audio: { type: "string" }, durationSec: { type: "number" }, callDate: { type: "string" } },
    },
    format: { type: "string" },
    targetDurationSec: { type: "number" },
    hook: {
      type: "object",
      additionalProperties: false,
      required: ["text", "type", "firstFrame"],
      properties: { text: { type: "string" }, type: { type: "string" }, firstFrame: { type: "string" } },
    },
    cuts: {
      type: "array",
      minItems: 5,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["idx", "tStart", "tEnd", "sourceRange", "speaker", "caption", "bubble", "visual", "sfx", "camera"],
        properties: {
          idx: { type: "integer" },
          tStart: { type: "number" },
          tEnd: { type: "number" },
          sourceRange: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
          speaker: { type: "string", enum: ["GF", "BF"] },
          caption: { type: "string" },
          bubble: { type: ["string", "null"] },
          visual: {
            type: "object",
            additionalProperties: false,
            required: ["scene", "emotion", "props", "action"],
            properties: {
              scene: { type: "string" },
              emotion: { type: "string" },
              props: { type: "array", items: { type: "string" } },
              action: { type: "string" },
            },
          },
          sfx: { type: ["string", "null"] },
          camera: {
            type: "object",
            additionalProperties: false,
            required: ["rotateDeg"],
            properties: { rotateDeg: { type: "number" } },
          },
        },
      },
    },
    punchline: {
      type: "object",
      additionalProperties: false,
      required: ["text", "t"],
      properties: { text: { type: "string" }, t: { type: "number" } },
    },
    loop: {
      type: "object",
      additionalProperties: false,
      required: ["lastLine", "connectsToCut"],
      properties: { lastLine: { type: "string" }, connectsToCut: { type: "integer" } },
    },
    redactions: { type: "array", items: { type: "string" } },
    aiDisclosure: {
      type: "object",
      additionalProperties: false,
      required: ["youtube", "instagram", "tiktok", "reason"],
      properties: {
        youtube: { type: "boolean" },
        instagram: { type: "boolean" },
        tiktok: { type: "boolean" },
        reason: { type: "string" },
      },
    },
    platformMeta: {
      type: "object",
      additionalProperties: false,
      required: ["youtube", "instagram", "tiktok"],
      properties: Object.fromEntries(
        ["youtube", "instagram", "tiktok"].map((platform) => [
          platform,
          {
            type: "object",
            additionalProperties: false,
            required: ["title", "caption", "hashtags"],
            properties: {
              title: { type: "string" },
              caption: { type: "string" },
              hashtags: { type: "array", items: { type: "string" }, maxItems: 5 },
            },
          },
        ]),
      ),
    },
  },
} as const;

export function fitCaption(text: string, maxChars = MAX_CAPTION_CHARS): string {
  const cleaned = text.split(/\s+/).join(" ").trim().replace(/^[\s,.!?~…"'"]+|[\s,.!?~…"'"]+$/g, "");
  if (cleaned.length <= maxChars) return cleaned;
  let out = "";
  for (const word of cleaned.split(" ")) {
    const candidate = out ? `${out} ${word}` : word;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  return out || cleaned.slice(0, maxChars);
}

function roleOf(transcript: Transcript, segment: { speaker: string }): string {
  return transcript.speakerMap[segment.speaker] ?? segment.speaker;
}

interface Beat {
  lead: Transcript["segments"][number];
  reply: Transcript["segments"][number];
  start: number;
  end: number;
}

function dialogueBeats(transcript: Transcript): Beat[] {
  const segments = transcript.segments.filter(
    (segment: Transcript["segments"][number]) => segment.text.trim() && ["GF", "BF"].includes(roleOf(transcript, segment)),
  );
  const beats: Beat[] = [];
  let index = 0;
  while (index < segments.length - 1) {
    const lead = segments[index];
    const reply = segments[index + 1];
    if (lead.speaker !== reply.speaker) {
      beats.push({ lead, reply, start: lead.start, end: reply.end });
      index += 2;
    } else {
      index += 1;
    }
  }
  return beats;
}

function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = (items.length - 1) / Math.max(1, count - 1);
  const picks = [...new Set(Array.from({ length: count }, (_, index) => Math.round(index * step)))].sort((a, b) => a - b);
  return picks.map((index) => items[index]);
}

const MOCK_SCENES = [
  "둘이 각자 이불 속에서 폰을 들고 통화 중, 방은 어둡고 폰 불빛만",
  "천장을 보며 폰을 귀에 대고 누운 두 사람, 창밖에 달",
  "한 손에 폰을 든 채 이불을 끌어당기는 장면",
  "폰 화면 불빛이 얼굴에 비치는 클로즈업",
  "식은땀을 닦으며 폰을 내려다보는 소년",
  "입을 손으로 막고 눈을 크게 뜬 소녀",
  "폰을 사이에 두고 서로 다른 방향을 보는 두 사람",
];
const MOCK_EMOTIONS = ["진지", "당황", "억울", "배신감", "뻔뻔함"];
const MOCK_ACTIONS = [
  "이불을 끝까지 끌어올리며 폰을 귀에 붙임",
  "천장을 보며 눈을 감았다 뜨고 입술을 오므림",
  "폰을 내려다보다가 식은땀을 닦음",
  "손으로 입을 막고 눈을 크게 뜸",
  "고개를 끄덕이다가 말이 끊겨 멈춤",
  "이불 밖으로 다리를 내리고 앉음",
  "폰을 이마에 대고 한숨을 쉼",
];

export function mockHooks(transcript: Transcript): string {
  const beats = dialogueBeats(transcript);
  if (!beats.length) throw new NeedsHumanError("전사문에 2인 대화 구간이 없어 훅을 만들 수 없습니다.");
  const strongest = beats.reduce((best, beat) => (beat.lead.text.length > best.lead.text.length ? beat : best), beats[0]);
  const first = fitCaption(beats[0].lead.text, 22);
  const strong = fitCaption(strongest.lead.text, 22);
  const rows: Array<[string, string, string, string]> = [
    ["충격 인용", `'${first}' 그 다음에 나온 말`, "여자 캐릭터가 입을 막은 손그림", `${beats[0].start.toFixed(1)}s`],
    ["공감 자기투영", "자기 전 통화에서 이 말 나오면 90% 싸움", "이불 속 두 사람, 폰 불빛", `${beats[Math.min(1, beats.length - 1)].start.toFixed(1)}s`],
    ["의문 갭", `'${strong}'라고 했는데 대답이 3초`, "식은땀 흘리는 소년 클로즈업", `${strongest.start.toFixed(1)}s`],
    ["숫자", "통화 30분째에 터진 한 문장", "벽시계와 폰을 함께 든 손", `${beats.at(-1)!.start.toFixed(1)}s`],
    ["배신·반전", "여친이 웃으면서 던진 마지막 한마디", "웃는 소녀, 굳은 소년", `${beats.at(-1)!.start.toFixed(1)}s`],
  ];
  const lines = ["| 훅 | 심리축 | 첫 프레임 | 회수 구간 |", "|---|---|---|---|"];
  for (const [axis, hook, frame, at] of rows) lines.push(`| ${hook} | ${axis} | ${frame} | ${at} |`);
  lines.push(
    "",
    `**추천:** ① '${rows[0][1]}'`,
    "- 0초에 실제 통화 목소리가 그대로 나와 '무슨 일이 있었나'를 즉시 만든다.",
    "- 회수 구간이 통화 초반이라 22초로 잘라도 완결된다.",
  );
  return lines.join("\n") + "\n";
}

export function mockEpisode(
  transcript: Transcript,
  options: { episodeId: string; callDate: string; audioName?: string },
): Episode {
  const beats = dialogueBeats(transcript);
  if (beats.length < 5) throw new NeedsHumanError(`2인 대화 구간이 ${beats.length}개뿐이라 5컷을 만들 수 없습니다.`);

  const used = new Set<string>();
  const chosen: Array<Beat & { caption: string }> = [];
  for (const beat of spread(beats, 7)) {
    const caption = fitCaption(beat.lead.text);
    if (!caption || used.has(caption)) continue;
    used.add(caption);
    chosen.push({ ...beat, caption });
  }
  if (chosen.length < 5) {
    for (const beat of beats) {
      const caption = fitCaption(beat.lead.text);
      if (caption && !used.has(caption)) {
        used.add(caption);
        chosen.push({ ...beat, caption });
      }
      if (chosen.length >= 6) break;
    }
  }
  chosen.splice(7);

  let durations = chosen.map((beat) => Math.max(2.6, beat.end - beat.start + 0.6));
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (total < 28) {
    const extra = (28.5 - total) / durations.length;
    durations = durations.map((value) => value + extra);
  } else if (total > 50) {
    const factor = 50 / total;
    durations = durations.map((value) => Math.max(2.4, value * factor));
  }

  const cuts: EpisodeCut[] = [];
  let cursor = 0;
  chosen.forEach((beat, index) => {
    const duration = Number(durations[index].toFixed(2));
    const role = roleOf(transcript, beat.lead) as "GF" | "BF";
    let sourceStart = beat.start;
    if (sourceStart + duration > transcript.durationSec) sourceStart = Math.max(0, transcript.durationSec - duration);
    cuts.push({
      idx: index + 1,
      tStart: Number(cursor.toFixed(2)),
      tEnd: Number((cursor + duration).toFixed(2)),
      sourceRange: [Number(sourceStart.toFixed(2)), Number((sourceStart + duration).toFixed(2))],
      speaker: role,
      caption: beat.caption,
      bubble: index === 3 ? "(왜 저러지)" : null,
      visual: {
        scene: MOCK_SCENES[index % MOCK_SCENES.length],
        emotion: MOCK_EMOTIONS[index % MOCK_EMOTIONS.length],
        props: ["이불", "스마트폰", "달"],
        action: MOCK_ACTIONS[index % MOCK_ACTIONS.length],
      },
      sfx: index === 0 || index === 3 ? "record_scratch" : null,
      camera: { rotateDeg: [1.5, -1.2, 0.9, -0.8, 1.1, -1.4, 0.7][index % 7] },
    });
    cursor = Number((cursor + duration).toFixed(2));
  });

  const totalSec = Number(cursor.toFixed(2));
  const firstCaption = cuts[0].caption;
  const lastReply = fitCaption(chosen.at(-1)!.reply.text, 12) || "타이밍 좋지";
  const platform = (title: string, caption: string, hashtags: string[]): PlatformMeta => ({ title, caption, hashtags });
  return {
    episodeId: options.episodeId,
    source: {
      audio: options.audioName ?? "call.m4a",
      durationSec: Number(transcript.durationSec.toFixed(2)),
      callDate: options.callDate,
    },
    format: "cold_open_quote",
    targetDurationSec: totalSec,
    hook: {
      text: `여친이 '${firstCaption}'라더니 진짜 한 말`,
      type: "quote_promise",
      firstFrame: "여자 캐릭터가 눈을 크게 뜨고 입을 막은 손그림",
    },
    cuts,
    punchline: { text: lastReply, t: Math.max(0, Number((totalSec - 2.2).toFixed(2))) },
    loop: { lastLine: "근데 왜 내가 사과했지?", connectsToCut: 1 },
    redactions: [],
    aiDisclosure: {
      youtube: false,
      instagram: false,
      tiktok: false,
      reason: "비사실적 손그림 일러스트 + 실제 통화 음성 — 세 플랫폼 모두 사실성 기준 의무 대상 아님",
    },
    platformMeta: {
      youtube: platform(`${firstCaption} 라고 하길래 #여친탐구생활`, "실제 통화 녹음 + 손그림. 그림은 AI, 목소리는 진짜.", ["#여친탐구생활", "#커플", "#썰", "#그림일기", "#숏폼"]),
      instagram: platform(`여친이 '${firstCaption}'라고 할 때`, "밤 통화에서 진짜 나온 말들. 그림 AI 생성(손그림 스타일), 목소리는 실제 통화.", ["#커플", "#연애", "#그림일기", "#썰", "#숏폼"]),
      tiktok: platform("통화 30분째에 터진 한 문장", "여친탐구생활 EP · 그림 AI, 목소리 실제 통화", ["#커플", "#썰", "#그림", "#연애", "#일상"]),
    },
  };
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeEpisode(
  input: unknown,
  transcript?: Transcript,
  options: { episodeId?: string; callDate?: string; audioName?: string } = {},
): Episode {
  const data = structuredClone(input) as Episode;
  if (options.episodeId) data.episodeId = options.episodeId;

  data.source ??= { audio: options.audioName ?? "call.m4a", durationSec: 0, callDate: options.callDate ?? new Date().toISOString().slice(0, 10) };
  if (transcript) data.source.durationSec ||= Number(transcript.durationSec.toFixed(2));
  data.source.audio ||= options.audioName ?? "call.m4a";
  data.source.callDate ||= options.callDate ?? new Date().toISOString().slice(0, 10);
  data.source.durationSec = asNumber(data.source.durationSec);

  if (Array.isArray(data.cuts)) {
    data.cuts = data.cuts
      .filter((cut) => cut && typeof cut === "object")
      .map((cut, index) => ({
        ...cut,
        idx: index + 1,
        speaker: String(cut.speaker ?? "").toUpperCase() as "GF" | "BF",
        caption: String(cut.caption ?? "").split(/\s+/).join(" ").trim(),
        tStart: Number(asNumber(cut.tStart).toFixed(2)),
        tEnd: Number(asNumber(cut.tEnd).toFixed(2)),
        sourceRange: Array.isArray(cut.sourceRange)
          ? ([Number(asNumber(cut.sourceRange[0]).toFixed(2)), Number(asNumber(cut.sourceRange[1]).toFixed(2))] as [number, number])
          : cut.sourceRange,
        visual: {
          ...cut.visual,
          scene: String(cut.visual?.scene ?? "").trim(),
          emotion: String(cut.visual?.emotion ?? "").trim(),
          props: Array.isArray(cut.visual?.props) ? cut.visual.props.map(String) : [],
          action: String(cut.visual?.action ?? "").trim(),
        },
        camera: {
          rotateDeg: asNumber(cut.camera?.rotateDeg),
        },
        bubble: cut.bubble === undefined ? null : cut.bubble,
        sfx: cut.sfx ?? null,
      }));
  }

  const total = totalDuration(data);
  if (total) data.targetDurationSec = Number(total.toFixed(2));

  if (data.hook) {
    data.hook.text = String(data.hook.text ?? "").split(/\s+/).join(" ").trim();
    data.hook.type = String(data.hook.type ?? "quote_promise");
    data.hook.firstFrame = String(data.hook.firstFrame ?? "첫 컷 캐릭터 클로즈업");
  }
  if (data.punchline) {
    data.punchline.text = String(data.punchline.text ?? "").split(/\s+/).join(" ").trim();
    data.punchline.t = Number(asNumber(data.punchline.t, Math.max(0, total - 2)).toFixed(2));
  }
  if (data.loop) {
    data.loop.lastLine = String(data.loop.lastLine ?? "");
    data.loop.connectsToCut = Math.trunc(asNumber(data.loop.connectsToCut, 1));
  }

  if (data.platformMeta) {
    for (const block of Object.values(data.platformMeta)) {
      if (!block) continue;
      const raw = Array.isArray(block.hashtags) ? block.hashtags : [];
      const tags: string[] = [];
      for (const tag of raw) {
        const value = String(tag).trim();
        if (!value) continue;
        const normalized = value.startsWith("#") ? value : `#${value.replace(/^#+/, "")}`;
        if (!tags.includes(normalized)) tags.push(normalized);
      }
      block.hashtags = tags.slice(0, 5);
    }
  }

  return data;
}

function parseJson(raw: string): unknown {
  const text = stripFence(raw);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new NeedsHumanError("모델 응답에서 JSON을 찾지 못했습니다.", { hint: text.slice(0, 200) });
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new NeedsHumanError("모델 응답 JSON을 해석하지 못했습니다.", { hint: text.slice(0, 200) });
    }
  }
}

export interface ScriptWriterDeps {
  planner?: TextClient;
  formatter?: TextClient;
}

export class ScriptWriter {
  private readonly config: Config;
  private readonly deps: ScriptWriterDeps;
  private readonly guard?: BudgetGuard;

  constructor(config: Config, store?: StateStore, deps: ScriptWriterDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.guard = store ? new BudgetGuard(config, store) : undefined;
  }

  async plan(projectDir: string, transcript: Transcript): Promise<string> {
    const planDir = path.join(projectDir, "plan");
    mkdirSync(planDir, { recursive: true });
    const text = planningText(projectDir) || transcriptAsPlain(transcript);

    let hooks: string;
    if (this.deps.planner) {
      hooks = await this.deps.planner.complete({ prompt: buildHookPrompt(text), system: HOOK_SYSTEM, maxTokens: 2000 });
      this.guard?.recordLlm("planner", "plan", projectDir);
    } else if (this.config.dryRun) {
      hooks = mockHooks(transcript);
    } else {
      this.guard?.checkLlm(projectDir);
      hooks = await callAnthropic(this.config, { prompt: buildHookPrompt(text), system: HOOK_SYSTEM, maxTokens: 2000 });
      this.guard?.recordLlm("anthropic", "plan", projectDir);
    }

    const file = path.join(planDir, "hooks.md");
    writeFileSync(
      file,
      `# EP 기획 — 훅 후보\n\n생성: ${new Date().toISOString().slice(0, 10)} · 모드: ${
        this.deps.planner ? "llm" : this.config.dryRun ? "dry-run(mock)" : "llm"
      }\n\n${hooks.trim()}\n`,
      "utf8",
    );
    return file;
  }

  async writeEpisode(projectDir: string, transcript: Transcript): Promise<Episode> {
    const planDir = path.join(projectDir, "plan");
    const hooksFile = path.join(planDir, "hooks.md");
    const hooks = existsSync(hooksFile) ? readFileSync(hooksFile, "utf8") : "";
    const text = planningText(projectDir) || transcriptAsPlain(transcript);
    const baseName = path.basename(projectDir);
    const episodeId = baseName.includes("_") ? baseName.split("_")[1].split("-")[0] : baseName || "EP";
    const callDate = /^\d{4}-\d{2}-\d{2}/.test(baseName) ? baseName.slice(0, 10) : new Date().toISOString().slice(0, 10);

    const useMock = !this.deps.formatter && this.config.dryRun;

    const build = async (request: TextRequest): Promise<Episode> => {
      if (useMock) return mockEpisode(transcript, { episodeId, callDate });
      const raw = this.deps.formatter
        ? await this.deps.formatter.complete(request)
        : await callOpenAI(this.config, request);
      this.guard?.recordLlm("formatter", "plan", projectDir);
      return normalizeEpisode(parseJson(raw), transcript, { episodeId, callDate, audioName: "call.m4a" });
    };

    if (!useMock && !this.deps.formatter) this.guard?.checkLlm(projectDir);
    let episode = await build({
      prompt: buildEpisodePrompt(hooks, text, transcript.durationSec),
      system: EPISODE_SYSTEM,
      maxTokens: 6000,
      schema: EPISODE_SCHEMA as unknown as Record<string, unknown>,
    });

    const redacted = redactEpisode(episode, this.config.redactionTerms);
    episode = redacted.episode;

    let issues = validateEpisode(episode, transcript);
    if (issues.length) {
      writeFileSync(path.join(planDir, "episode.rejected.json"), JSON.stringify(episode, null, 2), "utf8");
      if (this.deps.formatter || !this.config.dryRun) {
        episode = await this.repair(episode, issues, transcript, text, projectDir, episodeId, callDate, build);
        episode = redactEpisode(episode, this.config.redactionTerms).episode;
        issues = validateEpisode(episode, transcript);
      }
      if (issues.length) {
        saveValidationErrors(projectDir, issues);
        throw new NeedsHumanError(`episode.json이 검증을 통과하지 못했습니다 (${issues.length}건)`, {
          hint: "plan/validation_errors.txt 를 확인하고 plan/episode.json 을 직접 고친 뒤 resume --stage illustrate 로 이어가세요.",
        });
      }
    }

    saveEpisode(projectDir, episode);
    writeFileSync(
      path.join(planDir, "beats.json"),
      JSON.stringify(
        episode.cuts.map((cut) => ({
          idx: cut.idx,
          speaker: cut.speaker,
          caption: cut.caption,
          t: [cut.tStart, cut.tEnd],
          source: cut.sourceRange,
        })),
        null,
        2,
      ),
      "utf8",
    );
    return episode;
  }

  private async repair(
    episode: Episode,
    issues: string[],
    transcript: Transcript,
    text: string,
    projectDir: string,
    episodeId: string,
    callDate: string,
    build: (request: TextRequest) => Promise<Episode>,
  ): Promise<Episode> {
    try {
      this.guard?.checkLlm(projectDir);
      return await build({
        prompt: buildRepairPrompt(issues, episode, text),
        system: EPISODE_SYSTEM,
        maxTokens: 6000,
        schema: EPISODE_SCHEMA as unknown as Record<string, unknown>,
      });
    } catch (error) {
      if (error instanceof NeedsHumanError || error instanceof BudgetExceededError) throw error;
      return episode;
    }
  }
}

function transcriptAsPlain(transcript: Transcript): string {
  return transcript.segments
    .map((segment: Transcript["segments"][number]) => {
      const role = transcript.speakerMap[segment.speaker] ?? segment.speaker;
      return `[${segment.start.toFixed(1)}s] ${role}: ${segment.text}`;
    })
    .join("\n");
}
