import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";

function defaults() {
  return loadConfig({ env: {}, useDotenv: false });
}

test("the image budget covers one first episode", () => {
  const config = defaults();
  // 첫 편: 캐릭터 시트 2세트×3역할=6장 + 7컷 = 13장
  const firstEpisode = 13 * config.imagePriceUsd;
  assert.equal(config.maxImageUsd, 2.5);
  assert.ok(config.maxImageUsd > firstEpisode, `max=${config.maxImageUsd} first=${firstEpisode}`);
});

test("the image budget never exceeds the per-episode budget", () => {
  const config = defaults();
  assert.ok(config.maxImageUsd <= config.maxEpisodeUsd);
  assert.ok(config.maxEpisodeUsd <= config.dailyBudgetUsd * 2);
});
