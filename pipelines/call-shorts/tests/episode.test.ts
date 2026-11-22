import test from "node:test";
import assert from "node:assert/strict";

import { totalDuration, validateEpisode } from "../src/episode.js";
import { deepCopy, fixtureEpisode, fixtureTranscript } from "./helpers.js";

const transcript = fixtureTranscript();
const episode = fixtureEpisode(transcript);

test("mock episode passes every schema rule", () => {
  assert.deepEqual(validateEpisode(episode, transcript), []);
  assert.ok(episode.cuts.length >= 5 && episode.cuts.length <= 8);
  assert.ok(episode.cuts.every((cut) => cut.caption.length <= 14));
});

test("total duration is the tail of the last cut and within 25~55s", () => {
  const total = totalDuration(episode);
  assert.equal(total, episode.cuts.at(-1)!.tEnd);
  assert.ok(total >= 25 && total <= 55, `total=${total}`);
});

test("too few cuts is rejected", () => {
  const data = deepCopy(episode);
  data.cuts = data.cuts.slice(0, 4);
  const issues = validateEpisode(data, transcript);
  assert.ok(issues.some((issue) => issue.includes("cuts 개수") || issue.includes("이어지지")));
});

test("caption longer than 14 characters is rejected", () => {
  const data = deepCopy(episode);
  data.cuts[1].caption = "이 자막은 열네 글자를 확실히 넘기는 문장입니다";
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("한 줄이")));
});

test("cut shorter than caption reading time is rejected", () => {
  const data = deepCopy(episode);
  data.cuts[2].tEnd = data.cuts[2].tStart + 0.7;
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("못 미칩니다")));
});

test("first cut must start at zero and cuts must be contiguous", () => {
  const shifted = deepCopy(episode);
  shifted.cuts[0].tStart = 1.2;
  assert.ok(validateEpisode(shifted, transcript).some((issue) => issue.includes("0초에서 시작")));

  const gap = deepCopy(episode);
  gap.cuts[2].tStart += 0.5;
  assert.ok(validateEpisode(gap, transcript).some((issue) => issue.includes("이어지지")));
});

test("total length outside 25~55s is rejected", () => {
  const data = deepCopy(episode);
  const last = data.cuts.at(-1)!;
  last.tEnd = last.tStart + 40;
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("전체 길이")));
});

test("first caption must quote the real utterance", () => {
  const data = deepCopy(episode);
  data.cuts[0].caption = "오늘 날씨 진짜 좋다";
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("인용이 아닙니다")));
});

test("source range must overlap that speaker's speech", () => {
  const data = deepCopy(episode);
  data.cuts[1].sourceRange = [0, 0.5];
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("발화가 없습니다") || issue.includes("겹칩니다")));
});

test("source range shorter than the cut is rejected", () => {
  const data = deepCopy(episode);
  const cut = data.cuts[3];
  cut.sourceRange = [cut.sourceRange[0], cut.sourceRange[0] + 0.4];
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("짧습니다")));
});

test("duplicate captions are rejected", () => {
  const data = deepCopy(episode);
  data.cuts[2].caption = data.cuts[1].caption;
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("같습니다")));
});

test("speaker must be GF or BF", () => {
  const data = deepCopy(episode);
  // @ts-expect-error 잘못된 화자 값을 일부러 넣습니다
  data.cuts[0].speaker = "ME";
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("GF/BF")));
});

test("missing disclosure, hashtag overflow and missing hook are rejected", () => {
  const noDisclosure = deepCopy(episode) as unknown as Record<string, unknown>;
  delete noDisclosure.aiDisclosure;
  assert.ok(validateEpisode(noDisclosure, transcript).some((issue) => issue.includes("aiDisclosure")));

  const tags = deepCopy(episode);
  tags.platformMeta.tiktok.hashtags = ["#1", "#2", "#3", "#4", "#5", "#6"];
  assert.ok(validateEpisode(tags, transcript).some((issue) => issue.includes("최대 5개")));

  const noHook = deepCopy(episode) as unknown as Record<string, unknown>;
  delete noHook.hook;
  assert.ok(validateEpisode(noHook, transcript).some((issue) => issue.includes("필수 필드")));
});

test("punchline outside the video length is rejected", () => {
  const data = deepCopy(episode);
  data.punchline.t = totalDuration(data) + 5;
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("영상 길이")));
});

test("three caption lines are rejected", () => {
  const data = deepCopy(episode);
  data.cuts[1].caption = "하나\n둘\n셋";
  assert.ok(validateEpisode(data, transcript).some((issue) => issue.includes("줄입니다")));
});

test("non-object input is rejected", () => {
  assert.deepEqual(validateEpisode(["nope"]), ["episode.json 최상위가 객체가 아닙니다."]);
});
