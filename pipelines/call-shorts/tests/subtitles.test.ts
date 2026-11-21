import test from "node:test";
import assert from "node:assert/strict";

import {
  assColor,
  assTime,
  buildAss,
  buildCoverAss,
  buildSrt,
  srtTime,
  SUBTITLE_MARGIN_V,
  wrapCaption,
} from "../src/subtitles.js";
import { deepCopy, fixtureEpisode, makeConfig } from "./helpers.js";

const config = makeConfig();
const episode = fixtureEpisode();

test("ASS colors convert RGB to BGR", () => {
  assert.equal(assColor("#FF6B9D"), "&H009D6BFF");
  assert.equal(assColor("#4FC3F7"), "&H00F7C34F");
  assert.equal(assColor("000000"), "&H00000000");
});

test("ASS and SRT time formats", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(61.5), "0:01:01.50");
  assert.equal(assTime(3723.04), "1:02:03.04");
  assert.equal(srtTime(61.5), "00:01:01,500");
});

test("captions wrap to at most two lines of 14 characters", () => {
  const lines = wrapCaption("이 문장은 열네 글자를 넘기 때문에 두 줄로 나뉘어야 합니다", 14);
  assert.ok(lines.length <= 2);
  assert.ok(lines.every((line) => line.length <= 14));
  assert.deepEqual(wrapCaption("짧아요"), ["짧아요"]);
  assert.deepEqual(wrapCaption(""), []);
});

test("a single long word is hard-split instead of overflowing", () => {
  const lines = wrapCaption("가나다라마바사아자차카타파하가나다라", 14);
  assert.ok(lines.every((line) => line.length <= 14));
});

test("ASS uses fixed speaker colors and the three key styles", () => {
  const text = buildAss(episode, config);
  assert.match(text, new RegExp(`PlayResX: ${config.renderWidth}`));
  assert.match(text, new RegExp(`PlayResY: ${config.renderHeight}`));
  assert.match(text, /&H009D6BFF/);
  assert.match(text, /&H00F7C34F/);
  assert.match(text, /Style: Hook/);
  assert.match(text, /Style: Punch/);
  assert.match(text, /Style: Bubble/);
});

test("every cut gets a dialogue event and the hook sits at 0~3s", () => {
  const text = buildAss(episode, config);
  const dialogues = text.split("\n").filter((line) => line.startsWith("Dialogue:"));
  const bubbles = episode.cuts.filter((cut) => cut.bubble).length;
  assert.equal(dialogues.length, episode.cuts.length + 1 + 1 + bubbles);
  assert.ok(dialogues.some((line) => line.startsWith("Dialogue: 1,0:00:00.00,0:00:03.00,Hook")));
  for (const cut of episode.cuts) assert.ok(text.includes(cut.caption.split(" ")[0]));
});

test("subtitle margin sits inside the safe zone", () => {
  const ratio = SUBTITLE_MARGIN_V / config.renderHeight;
  assert.ok(ratio >= 0.12 && ratio <= 0.18, `ratio=${ratio}`);
});

test("braces in captions are escaped for ASS", () => {
  const data = deepCopy(episode);
  data.cuts[0].caption = "{폰트} 바꿔";
  const text = buildAss(data, config);
  assert.ok(!text.includes("{폰트}"));
  assert.ok(text.includes("(폰트)"));
});

test("SRT numbering includes the punchline", () => {
  const srt = buildSrt(episode);
  const blocks = srt.split("\n\n").filter(Boolean);
  assert.match(blocks[0], /^1\n/);
  assert.ok(blocks[0].includes(" --> "));
  assert.equal(blocks.length, episode.cuts.length + 1);
});

test("cover ASS carries the hook text", () => {
  const cover = buildCoverAss(episode, config);
  assert.match(cover, /Style: Cover/);
  assert.match(cover, /Dialogue: 0,0:00:00.00,0:00:05.00,Cover/);
});

test("events are sorted by start time", () => {
  const starts = buildAss(episode, config)
    .split("\n")
    .filter((line) => line.startsWith("Dialogue:"))
    .map((line) => line.split(",")[1])
    .map((stamp) => {
      const [hours, minutes, rest] = stamp.split(":");
      return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
    });
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});
