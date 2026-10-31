import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSubtitleFile,
  serializeSrt,
  MAX_SUBTITLE_BYTES,
} from "../../src/features/subtitle-files/model/subtitles";
const srt =
  "1\r\n00:00:00,100 --> 00:00:01,250\r\n직접 걸어봤어요.\r\n\r\n2\r\n00:00:01,250 --> 00:00:03,000\r\n다음 장면도\r\n확인했어요.\r\n";
test("imports BOM/CRLF Korean SRT with contiguous half-open cues and two lines", () => {
  let id = 0;
  const result = parseSubtitleFile(
    "\uFEFF" + srt,
    "clip.SRT",
    5,
    () => `cue-${++id}`,
  );
  assert.deepEqual(result.cues, [
    { id: "cue-1", start: 0.1, end: 1.25, text: "직접 걸어봤어요." },
    { id: "cue-2", start: 1.25, end: 3, text: "다음 장면도\n확인했어요." },
  ]);
});
test("basic WebVTT supports identifiers, short timestamps and explicit notes", () => {
  const r = parseSubtitleFile(
    "WEBVTT\n\nNOTE comment\nnot a caption\n\nopening\n00:00.500 --> 00:02.000\n한 장면을 봤어요.",
    "clip.vtt",
    4,
  );
  assert.equal(r.ignoredNotes, 1);
  assert.equal(r.cues[0].start, 0.5);
  assert.equal(r.cues[0].text, "한 장면을 봤어요.");
});
test("rejects the entire import instead of silently dropping malformed cues", () => {
  for (const body of [
    srt + "\n잘못된 구간\n남겨야 하는 문구",
    srt.replace(
      "00:00:01,250 --> 00:00:03,000",
      "00:00:01,000 --> 00:00:03,000",
    ),
    srt.replace("00:00:03,000", "00:00:09,000"),
    srt.replace("다음 장면도\r\n확인했어요.", "첫 줄\n둘째 줄\n셋째 줄"),
  ])
    assert.throws(() => parseSubtitleFile(body, "clip.srt", 5));
});
test("rejects malformed time, unsupported layout/markup, non-UTF8 and oversized input", () => {
  for (const body of [
    srt.replace("00:00:00,100", "00:61:00,100"),
    srt.replace("직접 걸어봤어요.", "<i>직접 걸어봤어요.</i>"),
    srt.replace("직접 걸어봤어요.", "\uFFFD"),
  ])
    assert.throws(() => parseSubtitleFile(body, "clip.srt", 9999));
  assert.throws(() =>
    parseSubtitleFile(
      "WEBVTT\n\n00:00.000 --> 00:01.000 align:start\n문구",
      "a.vtt",
      3,
    ),
  );
  assert.throws(() =>
    parseSubtitleFile("WEBVTT\n\nSTYLE\n::cue { color:red }", "a.vtt", 3),
  );
  assert.throws(() =>
    parseSubtitleFile("x".repeat(MAX_SUBTITLE_BYTES + 1), "a.srt", 5),
  );
  assert.throws(() => parseSubtitleFile(srt, "a.exe", 5));
});
test("round trips SRT without altering text or supported timestamps", () => {
  const cues = parseSubtitleFile(srt, "a.srt", 5).cues;
  const exported = serializeSrt(cues, 5);
  assert.match(exported, /00:00:00,100 --> 00:00:01,250/);
  assert.deepEqual(
    parseSubtitleFile(exported, "b.srt", 5).cues.map(({ id, ...cue }) => cue),
    cues.map(({ id, ...cue }) => cue),
  );
});
test("export handles minute rollover and rejects sub-millisecond collapse", () => {
  assert.match(
    serializeSrt(
      [{ id: "a", start: 59.9996, end: 61, text: "다음 분이에요." }],
      62,
    ),
    /00:01:00,000 --> 00:01:01,000/,
  );
  assert.throws(() =>
    serializeSrt([{ id: "a", start: 0, end: 0.0001, text: "너무 짧아요." }], 1),
  );
});
