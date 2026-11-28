import path from "node:path";
import { constants } from "node:fs";
import { link, lstat, open, readFile, stat } from "node:fs/promises";

// OpenAI gpt-transcribe returns text only (no verbose_json / word timestamps).
// Keep local Whisper word timings for cuts and attach the API wording to them.
export const apiFiles = ["transcript.api.json", "transcript.api.md"] as const;
export const apiModel = "gpt-transcribe";

export type TimedWord = { word: string; start: number; end: number };
export type ApiWord = { word: string; start: number; end: number; match: number };

const isKept = (c: string) => /[\p{L}\p{N}]/u.test(c);
const chars = (s: string) => Array.from(s.normalize("NFC").toLowerCase()).filter(isKept);
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Align API text tokens to timed Whisper words by banded character edit distance.
 * Every API token gets a time. `match` is the share of its characters that equal
 * the aligned Whisper character (0 = inserted by the API, interpolated time).
 */
export function alignApiText(words: TimedWord[], text: string): ApiWord[] {
  const tokens = text.normalize("NFC").split(/\s+/).filter(Boolean);
  const ac: string[] = [], at0: number[] = [], at1: number[] = [];
  for (const w of words) {
    const cs = chars(w.word);
    const d = Math.max(0, w.end - w.start);
    cs.forEach((c, i) => { ac.push(c); at0.push(w.start + d * i / cs.length); at1.push(w.start + d * (i + 1) / cs.length); });
  }
  const bc: string[] = [], bt: number[] = [];
  tokens.forEach((tok, k) => chars(tok).forEach(c => { bc.push(c); bt.push(k); }));
  const N = ac.length, M = bc.length;
  const mapped = new Int32Array(M).fill(-1);
  if (N && M) {
    const W = Math.max(150, Math.ceil(0.05 * Math.max(N, M)) + Math.abs(N - M));
    const width = 2 * W + 1;
    const center = (i: number) => Math.round(i * M / N);
    const dir = new Uint8Array((N + 1) * width); // 0 diag, 1 up(skip whisper), 2 left(api insert)
    const INF = 1 << 29;
    let prev = new Int32Array(width).fill(INF), cur = new Int32Array(width).fill(INF);
    for (let j = 0; j <= Math.min(M, W); j++) { prev[j - center(0) + W] = j; dir[j - center(0) + W] = 2; }
    for (let i = 1; i <= N; i++) {
      cur.fill(INF);
      const c = center(i), pc = center(i - 1);
      for (let j = Math.max(0, c - W); j <= Math.min(M, c + W); j++) {
        const x = j - c + W;
        let best = INF, d = 0;
        const px = j - 1 - pc + W;
        if (j > 0 && px >= 0 && px < width && prev[px] < INF) { best = prev[px] + (ac[i - 1] === bc[j - 1] ? 0 : 1); d = 0; }
        const ux = j - pc + W;
        if (ux >= 0 && ux < width && prev[ux] + 1 < best) { best = prev[ux] + 1; d = 1; }
        if (j > 0 && x > 0 && cur[x - 1] + 1 < best) { best = cur[x - 1] + 1; d = 2; }
        cur[x] = best; dir[i * width + x] = d;
      }
      [prev, cur] = [cur, prev];
    }
    let i = N, j = M;
    while (i > 0 || j > 0) {
      const x = j - center(i) + W;
      if (x < 0 || x >= width) break;
      const d = i === 0 ? 2 : dir[i * width + x];
      if (d === 0 && i > 0 && j > 0) { mapped[j - 1] = i - 1; i--; j--; }
      else if (d === 1 && i > 0) i--;
      else if (j > 0) j--;
      else i--;
    }
  }
  const out: ApiWord[] = tokens.map(word => ({ word, start: NaN, end: NaN, match: 0 }));
  const seen = new Int32Array(tokens.length);
  for (let j = 0; j < M; j++) {
    const k = bt[j], i = mapped[j];
    seen[k]++;
    if (i < 0) continue;
    const o = out[k];
    if (!(o.start <= at0[i])) o.start = at0[i];
    if (!(o.end >= at1[i])) o.end = at1[i];
    if (ac[i] === bc[j]) o.match++;
  }
  out.forEach((o, k) => { o.match = seen[k] ? round(o.match / seen[k]) : 0; });
  // Tokens without aligned characters (API-only words, punctuation) take the gap between neighbours.
  const last = words.length ? words[words.length - 1].end : 0;
  for (let k = 0; k < out.length; k++) {
    if (Number.isFinite(out[k].start)) continue;
    let p = k - 1; while (p >= 0 && !Number.isFinite(out[p].end)) p--;
    let n = k + 1; while (n < out.length && !Number.isFinite(out[n].start)) n++;
    const a = p >= 0 ? out[p].end : (words[0]?.start ?? 0);
    const b = n < out.length ? out[n].start : last;
    const span = Math.max(0, b - a) / (n - p);
    out[k].start = a + span * (k - p - 1);
    out[k].end = a + span * (k - p);
  }
  for (let k = 1; k < out.length; k++) if (out[k].start < out[k - 1].start) out[k].start = out[k - 1].start;
  return out.map(o => ({ word: o.word, start: round(o.start), end: round(Math.max(o.start, o.end)), match: o.match }));
}

const stamp = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

export function apiTranscriptMarkdown(aligned: ApiWord[]) {
  const lines = ["# 원본 시간대별 대본 · OpenAI 전사", "",
    `자동 전사 · 사람 확인 전 · 문장은 OpenAI ${apiModel}, 시각은 로컬 Whisper 단어 시각에 맞춤`, ""];
  let sentence: ApiWord[] = [];
  const flush = () => {
    if (sentence.length) lines.push(`[${stamp(sentence[0].start)}] ${sentence.map(w => w.word).join(" ")}`);
    sentence = [];
  };
  for (const w of aligned) { sentence.push(w); if (/[.?!…]["'”’)]*$/u.test(w.word)) flush(); }
  flush();
  return lines.join("\n") + "\n";
}

async function regularFile(file: string) {
  const s = await lstat(file).catch(() => undefined);
  return Boolean(s?.isFile() && s.size > 0);
}
async function writeNew(file: string, body: string) {
  const h = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(body); await h.sync(); } finally { await h.close(); }
}

export type ApiAttachResult =
  | { status: "added" | "reused"; directory: string }
  | { status: "skipped"; reason: string };

/**
 * Add `transcript.api.*` next to the Whisper result for one source version.
 * `cache` is the per-version result folder; `work` is the canonical folder when the
 * Whisper files were published there. Existing files are never replaced.
 */
export async function attachApiTranscript(options: {
  source: string; cache: string; work?: string; hint: string;
  transcribe: (file: string, context: string) => Promise<{ text: string }>;
}): Promise<ApiAttachResult> {
  const { source, cache, work, hint, transcribe } = options;
  const target = (name: string) => path.join(cache, name);
  let status: "added" | "reused" = "reused";
  if (!(await regularFile(target(apiFiles[0]))) || !(await regularFile(target(apiFiles[1])))) {
    let text: string;
    try { text = (await transcribe(source, hint)).text; }
    catch (e) { return { status: "skipped", reason: e instanceof Error ? e.message : "OpenAI 전사를 완료하지 못했어요." }; }
    const words: TimedWord[] = JSON.parse(await readFile(target("words.json"), "utf8"));
    const aligned = alignApiText(words, text);
    const json = JSON.stringify({ provider: "openai", model: apiModel, createdAt: new Date().toISOString(),
      timing: "local-whisper-words", text, words: aligned }, null, 1);
    try {
      await writeNew(target(apiFiles[0]), json);
      await writeNew(target(apiFiles[1]), apiTranscriptMarkdown(aligned));
    } catch { return { status: "skipped", reason: "OpenAI 전사 결과를 저장하지 못했어요. 기존 파일은 보존했어요." }; }
    status = "added";
  }
  if (!work) return { status, directory: cache };
  for (const name of apiFiles) {
    const dest = path.join(work, name);
    const existing = await lstat(dest).catch(() => undefined);
    if (!existing) await link(target(name), dest).catch(() => undefined);
    const [a, b] = await Promise.all([stat(dest).catch(() => undefined), stat(target(name))]);
    if (!a || a.ino !== b.ino || a.dev !== b.dev || (await lstat(dest)).isSymbolicLink()) return { status, directory: cache };
  }
  return { status, directory: work };
}
