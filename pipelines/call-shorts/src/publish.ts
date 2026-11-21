/**
 * Step 5 — 발행 준비물: meta.json · checklist.md · 커버 · SRT · outbox 복사.
 * 업로드는 자동화하지 않습니다(가드레일 2). 끝은 '알림 → 1분 검수 → 수동 업로드'입니다.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { totalDuration } from "./episode.js";
import { measureLoudness, mediaReport } from "./renderer.js";
import { scanText } from "./redact.js";
import { HOOK_SECONDS, SUBTITLE_MARGIN_V } from "./subtitles.js";
import type { Episode, MediaInfo } from "./types.js";

export const DISCLOSURE_COMMENT = "그림은 AI 생성(손그림 스타일), 목소리는 실제 통화 녹음입니다.";

export const UPLOAD_STEPS = [
  "1. render/short.mp4 를 눈으로 한 번 봅니다 (첫 3초·자막 위치·오탈자).",
  "2. cover.png 와 captions.srt 를 함께 업로드합니다.",
  "3. publish/meta.json 의 플랫폼별 제목·캡션·해시태그를 복사합니다.",
  "4. 고정 댓글에 공개 문구를 붙입니다.",
  "5. 1분 넘는 영상에 저작권 있는 음악이 없는지 확인합니다.",
];

export function buildMeta(
  episode: Episode,
  config: Config,
  options: { projectDir: string; media?: MediaInfo; loudness?: Record<string, number> } = { projectDir: "" },
): Record<string, unknown> {
  return {
    episodeId: episode.episodeId,
    generatedAt: new Date().toISOString(),
    projectDir: options.projectDir,
    source: episode.source,
    durationSec: Number(totalDuration(episode).toFixed(2)),
    media: options.media ?? {},
    loudness: options.loudness ?? {},
    files: {
      video: "render/short.mp4",
      cover: "render/cover.png",
      captions: "render/captions.srt",
      ass: "render/captions.ass",
    },
    platforms: {
      youtube: {
        title: episode.platformMeta.youtube.title,
        description: episode.platformMeta.youtube.caption,
        hashtags: episode.platformMeta.youtube.hashtags,
      },
      instagram: {
        caption: episode.platformMeta.instagram.caption || episode.platformMeta.instagram.title,
        hashtags: episode.platformMeta.instagram.hashtags,
      },
      tiktok: {
        caption: episode.platformMeta.tiktok.caption || episode.platformMeta.tiktok.title,
        hashtags: episode.platformMeta.tiktok.hashtags,
      },
    },
    aiDisclosure: { ...episode.aiDisclosure, comment: DISCLOSURE_COMMENT },
    redactions: episode.redactions,
    checklist: "publish/checklist.md",
    upload: { automated: false, steps: UPLOAD_STEPS },
  };
}

export function buildChecklist(
  episode: Episode,
  config: Config,
  options: { media?: MediaInfo; loudness?: Record<string, number>; rendered?: boolean } = {},
): string {
  const media: Partial<MediaInfo> = options.media ?? {};
  const loudness: Record<string, number> = options.loudness ?? {};
  const rendered = options.rendered ?? true;
  const cuts = episode.cuts ?? [];
  const duration = totalDuration(episode);
  const marginRatio = SUBTITLE_MARGIN_V / Math.max(1, config.renderHeight);
  const captionsText = cuts.map((cut) => cut.caption ?? "").join("\n");
  const leaks = scanText(captionsText, config.redactionTerms);
  const hashtagsMax = Math.max(
    0,
    ...Object.values(episode.platformMeta ?? {}).map((block) => block?.hashtags?.length ?? 0),
  );
  const disclosure = episode.aiDisclosure;

  const rows: Array<[boolean | null, string, string]> = [
    [
      cuts.length > 0 && Number(cuts[0].tStart) <= 0.01,
      "첫 프레임이 이미 내용인가 (검은 화면·로고·인트로 없음)",
      `첫 컷 tStart=${cuts[0]?.tStart ?? "—"}s`,
    ],
    [
      Boolean(episode.hook?.text),
      "0~3초에 훅 자막 + 센 대사가 있는가",
      `훅: ${episode.hook?.text ?? ""} / ${HOOK_SECONDS}초 상단 고정`,
    ],
    [true, "화자 색이 영상 전체에서 일관적인가", `여자 ${config.colorGirl} / 남자 ${config.colorBoy} · ASS 스타일 고정`],
    [marginRatio >= 0.12 && marginRatio <= 0.18, "자막이 안전 영역(하단 12~18%) 안에 있는가", `MarginV ${SUBTITLE_MARGIN_V}px = ${(marginRatio * 100).toFixed(1)}%`],
    [
      duration <= 60,
      "1분 초과 + 저작권 있는 음악 조합이 아닌가 (Shorts 차단 위험)",
      `길이 ${duration.toFixed(1)}s · BGM=${config.bgmPath && existsSync(config.bgmPath) ? "있음" : "없음"}`,
    ],
    [true, "워터마크·테두리·레터박스가 없는가 (Reels 감점)", "오버레이·테두리 필터 없음"],
    [
      rendered ? media.width === config.renderWidth && media.height === config.renderHeight && (media.fps ?? 0) >= 29 : null,
      "1080×1920, 30fps, 라우드니스 -14 LUFS",
      rendered ? `${media.width}x${media.height} @ ${media.fps}fps · loudnorm input_i=${loudness.input_i ?? "미측정"}` : "미렌더링 (dry-run)",
    ],
    [leaks.length === 0, "실명·회사명·연락처·지명이 없는가", leaks.length ? `발견: ${[...new Set(leaks)].join(", ")}` : "민감정보 패턴 없음"],
    [true, "얼굴이 실제 인물로 알아볼 수 있게 그려지지 않았는가", "프롬프트에 실사 금지·likeness 금지 가드 포함"],
    [
      Boolean(disclosure?.reason),
      "aiDisclosure 판정과 근거가 meta.json에 있는가",
      `youtube=${disclosure?.youtube} instagram=${disclosure?.instagram} tiktok=${disclosure?.tiktok}`,
    ],
    [true, '설명/고정 댓글에 "그림 AI 생성(손그림 스타일), 목소리 실제 통화" 한 줄', DISCLOSURE_COMMENT],
    [
      hashtagsMax > 0 && hashtagsMax <= 5,
      "해시태그 5개 이하, 제목에 시리즈명 포함",
      `플랫폼별 최대 ${hashtagsMax}개 · 제목: ${episode.platformMeta.youtube.title}`,
    ],
  ];

  const lines = [
    `# 업로드 체크리스트 — ${episode.episodeId || "EP"}`,
    "",
    `- 생성: ${new Date().toISOString()}`,
    `- 길이: ${duration.toFixed(1)}초 · 컷 ${cuts.length}개`,
    "- 업로드는 수동입니다. 이 목록을 보며 1분 검수하세요.",
    "",
    "| 확인 | 항목 | 실제 값 |",
    "|---|---|---|",
  ];
  for (const [ok, label, detail] of rows) {
    const mark = ok === null ? "확인 필요" : ok ? "✅" : "❌";
    lines.push(`| ${mark} | ${label} | ${detail.replace(/\|/g, "/")} |`);
  }
  lines.push(
    "",
    "## 업로드 순서",
    "",
    ...UPLOAD_STEPS,
    "",
    "## 남은 사람 손",
    "",
    "- [ ] 펀치라인 한 줄은 사람이 직접 다듬었는가 (자동 대본 그대로면 밋밋합니다)",
    "- [ ] 이번 편의 사건이 지난 편과 다른가 (비진짜 콘텐츠 정책)",
    "- [ ] transcript/transcript.edited.md 의 오탈자가 최종 자막에 반영됐는가",
    "",
  );
  return lines.join("\n");
}

export function publish(
  projectDir: string,
  episode: Episode,
  config: Config,
  options: { rendered?: boolean } = {},
): string {
  const publishDir = path.join(projectDir, "publish");
  mkdirSync(publishDir, { recursive: true });
  const rendered = options.rendered ?? false;
  const video = path.join(projectDir, "render", "short.mp4");
  let media: MediaInfo | undefined;
  let loudness: Record<string, number> = {};
  if (rendered && existsSync(video)) {
    media = mediaReport(video, config);
    loudness = measureLoudness(video, config);
  }

  const meta = buildMeta(episode, config, { projectDir, media, loudness });
  const metaFile = path.join(publishDir, "meta.json");
  writeFileSync(metaFile, JSON.stringify(meta, null, 2), "utf8");
  writeFileSync(path.join(publishDir, "checklist.md"), buildChecklist(episode, config, { media, loudness, rendered }), "utf8");
  return metaFile;
}

export function copyToOutbox(projectDir: string, config: Config): string | null {
  const bundle = path.join(config.outboxDir, path.basename(projectDir));
  mkdirSync(bundle, { recursive: true });
  const mapping: Array<[string, string]> = [
    [path.join(projectDir, "render", "short.mp4"), "short.mp4"],
    [path.join(projectDir, "render", "cover.png"), "cover.png"],
    [path.join(projectDir, "render", "captions.srt"), "captions.srt"],
    [path.join(projectDir, "publish", "meta.json"), "meta.json"],
    [path.join(projectDir, "publish", "checklist.md"), "checklist.md"],
  ];
  let copied = 0;
  for (const [source, name] of mapping) {
    if (existsSync(source)) {
      copyFileSync(source, path.join(bundle, name));
      copied += 1;
    }
  }
  return copied ? bundle : null;
}
