import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alignApiText, apiTranscriptMarkdown, attachApiTranscript } from "../../src/desktop/episode-api-transcript";

const words = [
  { word: " 안녕하세요", start: 0, end: 0.8 }, { word: " 후라이유입니다", start: 0.8, end: 1.7 },
  { word: " 오늘은", start: 3.6, end: 4.1 }, { word: " 공군을", start: 4.1, end: 4.6 }, { word: " 나왔거든요", start: 4.6, end: 5.3 },
  { word: " 학구", start: 7.0, end: 7.4 }, { word: " 유튜버", start: 7.4, end: 8.0 },
];

test("API 문장을 로컬 단어 시각에 맞춰 붙이고 고친 표기를 유지한다", () => {
  const aligned = alignApiText(words, "안녕하세요, 후라이윤입니다. 오늘은 공구를 나갔거든요. 음, 하꼬 유튜버!");
  assert.deepEqual(aligned.map(w => w.word), ["안녕하세요,", "후라이윤입니다.", "오늘은", "공구를", "나갔거든요.", "음,", "하꼬", "유튜버!"]);
  const at = (w: string) => aligned.find(a => a.word === w)!;
  assert.equal(at("안녕하세요,").start, 0);
  assert.equal(at("안녕하세요,").match, 1);
  assert.ok(at("후라이윤입니다.").start >= 0.8 && at("후라이윤입니다.").end <= 1.7);
  assert.ok(at("오늘은").start >= 3.6 && at("오늘은").start < 4.1);
  assert.ok(at("하꼬").start >= 7.0 && at("하꼬").end <= 7.4 + 1e-9);
  assert.ok(at("하꼬").match < 1);
  // API-only filler falls between its neighbours.
  assert.ok(at("음,").start >= at("나갔거든요.").end - 1e-9 && at("음,").end <= at("하꼬").start + 1e-9);
  assert.equal(at("음,").match, 0);
  for (let i = 1; i < aligned.length; i++) assert.ok(aligned[i].start >= aligned[i - 1].start);
});

test("긴 전사도 띠 정렬로 시각이 앞뒤로 뒤집히지 않는다", () => {
  const long = Array.from({ length: 1500 }, (_, i) => ({ word: ` 단어${i}번`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const text = long.map((w, i) => (i % 97 === 0 ? "어 " : "") + w.word.trim()).join(" ");
  const aligned = alignApiText(long, text);
  const exact = aligned.filter(a => a.match === 1);
  assert.ok(exact.length >= 1500);
  const w1000 = aligned.find(a => a.word === "단어1000번")!;
  assert.equal(w1000.start, 500);
  for (let i = 1; i < aligned.length; i++) assert.ok(aligned[i].start >= aligned[i - 1].start);
});

test("문장 단위로 시각 대본을 만든다", () => {
  const md = apiTranscriptMarkdown(alignApiText(words, "안녕하세요, 후라이윤입니다. 오늘은 공구를 나갔거든요. 하꼬 유튜버"));
  assert.match(md, /사람 확인 전/);
  assert.match(md, /\n\[0:00:00\] 안녕하세요, 후라이윤입니다\.\n\[0:00:03\] 오늘은 공구를 나갔거든요\.\n\[0:00:07\] 하꼬 유튜버\n$/);
});

test("결과를 버전 폴더에 쓰고 작업 폴더에 연결하며, 다시 실행하면 API를 부르지 않는다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "episode-api-"));
  try {
    const work = path.join(root, "work"), cache = path.join(work, "원본전사", "key");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "words.json"), JSON.stringify(words));
    let calls = 0;
    const transcribe = async (_file: string, context: string) => {
      calls++; assert.match(context, /후라이윤/);
      return { text: "안녕하세요, 후라이윤입니다." };
    };
    const first = await attachApiTranscript({ source: "/x.mov", cache, work, hint: "후라이윤 EP05", transcribe });
    assert.deepEqual(first, { status: "added", directory: work });
    const saved = JSON.parse(await readFile(path.join(work, "transcript.api.json"), "utf8"));
    assert.equal(saved.model, "gpt-transcribe");
    assert.equal(saved.timing, "local-whisper-words");
    assert.equal((await stat(path.join(work, "transcript.api.md"))).ino, (await stat(path.join(cache, "transcript.api.md"))).ino);
    const again = await attachApiTranscript({ source: "/x.mov", cache, work, hint: "후라이윤 EP05", transcribe });
    assert.deepEqual(again, { status: "reused", directory: work });
    assert.equal(calls, 1);

    // A human-edited canonical file is kept; the new version stays in its own folder.
    const cache2 = path.join(work, "원본전사", "key2");
    await mkdir(cache2);
    await writeFile(path.join(cache2, "words.json"), JSON.stringify(words));
    const other = await attachApiTranscript({ source: "/y.mov", cache: cache2, work, hint: "후라이윤", transcribe });
    assert.deepEqual(other, { status: "added", directory: cache2 });
    assert.equal(JSON.parse(await readFile(path.join(work, "transcript.api.json"), "utf8")).createdAt, saved.createdAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("크레딧이 꺼져 있으면 Whisper 결과만 두고 이유를 돌려준다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "episode-api-"));
  try {
    await writeFile(path.join(root, "words.json"), JSON.stringify(words));
    const result = await attachApiTranscript({ source: "/x.mov", cache: root, hint: "", transcribe: async () => {
      throw new Error("전사용 OpenAI 크레딧을 확인할 수 없어요.");
    } });
    assert.deepEqual(result, { status: "skipped", reason: "전사용 OpenAI 크레딧을 확인할 수 없어요." });
    await assert.rejects(stat(path.join(root, "transcript.api.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
