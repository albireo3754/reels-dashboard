import test from "node:test";
import assert from "node:assert/strict";

import { buildChecklist, LOUDNESS_TARGET_LUFS } from "../src/publish.js";
import { SENSITIVE_PATTERN_COUNT } from "../src/redact.js";
import type { MediaInfo } from "../src/types.js";
import { deepCopy, fixtureEpisode, makeConfig } from "./helpers.js";

const media: MediaInfo = { durationSec: 40, width: 1080, height: 1920, fps: 30, hasAudio: true };

function row(checklist: string, needle: string): string {
  const line = checklist.split("\n").find((entry) => entry.includes(needle));
  assert.ok(line, `${needle} 행이 없습니다:\n${checklist}`);
  return line;
}

test("the redaction row admits when only the built-in patterns ran", () => {
  const config = makeConfig();
  assert.deepEqual(config.redactionTerms, []);
  const line = row(buildChecklist(fixtureEpisode(), config, { rendered: false }), "민감 패턴");
  assert.match(line, /확인 필요/);
  assert.match(line, new RegExp(`정규식 ${SENSITIVE_PATTERN_COUNT}종만 검사`));
  assert.match(line, /금지어 미설정/);
});

test("the redaction row passes when configured terms were checked", () => {
  const config = makeConfig({ REDACTION_TERMS: "토스인컴,김민수" });
  const line = row(buildChecklist(fixtureEpisode(), config, { rendered: false }), "민감 패턴");
  assert.match(line, /✅/);
  assert.match(line, /금지어 2개/);
});

test("the redaction row fails when a caption leaks a phone number", () => {
  const episode = deepCopy(fixtureEpisode());
  episode.cuts[1].caption = "010-1234-5678";
  const line = row(buildChecklist(episode, makeConfig({ REDACTION_TERMS: "김민수" }), { rendered: false }), "민감 패턴");
  assert.match(line, /❌/);
  assert.match(line, /휴대전화/);
});

test("resolution and loudness are judged separately from the real measurement", () => {
  const config = makeConfig();
  const episode = fixtureEpisode();
  const ok = buildChecklist(episode, config, { rendered: true, media, loudness: { input_i: -14 } });
  assert.match(row(ok, "1080×1920"), /✅/);
  assert.match(row(ok, "1080×1920"), /1080x1920 @ 30fps/);
  assert.match(row(ok, "라우드니스"), /✅/);
  assert.match(row(ok, `-14.0 LUFS`), /통과/);

  const loud = buildChecklist(episode, config, { rendered: true, media, loudness: { input_i: -8 } });
  assert.match(row(loud, "라우드니스"), /❌/);
  assert.match(row(loud, "라우드니스"), /-8.0 LUFS/);
  assert.match(row(loud, "라우드니스"), /벗어남/);

  const quiet = buildChecklist(episode, config, { rendered: true, media, loudness: { input_i: -30 } });
  assert.match(row(quiet, "라우드니스"), /❌/);

  const unmeasured = buildChecklist(episode, config, { rendered: true, media, loudness: {} });
  assert.match(row(unmeasured, "라우드니스"), /확인 필요/);
  assert.match(row(unmeasured, "라우드니스"), /⚠️ 미측정/);

  const dryRun = buildChecklist(episode, config, { rendered: false });
  assert.match(row(dryRun, "라우드니스"), /확인 필요/);
  assert.match(row(dryRun, "라우드니스"), /미렌더링 \(dry-run\)/);
});

test("the loudness target stays at -14 LUFS", () => {
  assert.equal(LOUDNESS_TARGET_LUFS, -14);
});
