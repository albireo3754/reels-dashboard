/**
 * 대본·자막 마스킹 — 실명·회사명·연락처·주소가 영상에 남지 않게.
 * 원문은 transcript/ 에만 남기고, episode.json/자막/메타는 가립니다(가드레일 4).
 */

import type { Episode } from "./types.js";

export const MASK = "[마스킹]";

const PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "주민등록번호", pattern: /\b\d{6}[- ]?[1-4]\d{6}\b/g },
  { label: "휴대전화", pattern: /\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g },
  { label: "유선전화", pattern: /\b0(?:2|[3-6]\d)[-. ]?\d{3,4}[-. ]?\d{4}\b/g },
  { label: "이메일", pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { label: "계좌번호", pattern: /\b\d{2,6}-\d{2,6}-\d{4,8}\b/g },
  { label: "카드번호", pattern: /\b(?:\d{4}[- ]?){3}\d{4}\b/g },
  { label: "우편번호·주소", pattern: /\b\d{5}\s?(?:로|길)\b/g },
];

export function scanText(text: string, terms: string[] = []): string[] {
  const hits: string[] = [];
  for (const { label, pattern } of patterns()) {
    if (pattern.test(text ?? "")) hits.push(label);
  }
  for (const term of terms) if (term && (text ?? "").includes(term)) hits.push(`지정어:${term}`);
  return hits;
}

function patterns(): Array<{ label: string; pattern: RegExp }> {
  // g 플래그 정규식은 test() 호출마다 lastIndex가 바뀌므로 매번 새로 만듭니다.
  return PATTERNS.map(({ label, pattern }) => ({ label, pattern: new RegExp(pattern.source, "g") }));
}

export function redactText(text: string, terms: string[] = []): { text: string; hits: string[] } {
  if (!text) return { text, hits: [] };
  let result = text;
  const hits: string[] = [];
  for (const term of terms) {
    if (term && result.includes(term)) {
      result = result.split(term).join(MASK);
      hits.push(`지정어:${term}`);
    }
  }
  for (const { label, pattern } of patterns()) {
    let count = 0;
    result = result.replace(pattern, () => {
      count += 1;
      return MASK;
    });
    if (count) hits.push(`${label}x${count}`);
  }
  return { text: result, hits };
}

export function redactEpisode(episode: Episode, terms: string[] = []): { episode: Episode; hits: string[] } {
  const data = structuredClone(episode) as Episode;
  const hits: string[] = [];
  const mask = (value: string): string => {
    const result = redactText(value, terms);
    hits.push(...result.hits);
    return result.text;
  };

  data.hook.text = mask(data.hook.text);
  data.hook.firstFrame = mask(data.hook.firstFrame);
  data.punchline.text = mask(data.punchline.text);
  if (data.loop) data.loop.lastLine = mask(data.loop.lastLine);

  for (const cut of data.cuts ?? []) {
    cut.caption = mask(cut.caption);
    if (cut.bubble) cut.bubble = mask(cut.bubble);
    if (cut.visual?.scene) cut.visual.scene = mask(cut.visual.scene);
  }

  for (const block of Object.values(data.platformMeta ?? {})) {
    if (!block) continue;
    block.title = mask(block.title ?? "");
    block.caption = mask(block.caption ?? "");
  }

  const categories = [...new Set(hits.map((hit) => hit.split("x")[0]))].sort();
  const existing = Array.isArray(data.redactions) ? data.redactions : [];
  data.redactions = [...new Set([...existing, ...categories])];
  return { episode: data, hits };
}
