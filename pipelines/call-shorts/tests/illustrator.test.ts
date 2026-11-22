import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderDoodleCut } from "../src/doodle.js";
import { Illustrator } from "../src/illustrator.js";
import { BudgetExceededError } from "../src/errors.js";
import type { ImageModel } from "../src/providers.js";
import { Pipeline } from "../src/runner.js";
import { StateStore } from "../src/state.js";
import { fixtureEpisode, makeConfig, makeDryConfig, makeProject, writeFakeAudio } from "./helpers.js";

function pricedModel(priceUsd: number): ImageModel {
  return {
    name: "fake-image",
    priceUsd,
    async generate(request) {
      return renderDoodleCut(request.dest, 1, { width: 90, height: 160 });
    },
  };
}

function fixCharacterSheets(dir: string): void {
  for (const role of ["girl", "boy", "style"]) {
    writeFileSync(path.join(dir, `char_sheet_${role}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]), "utf8");
  }
}

test("a budget overrun while drawing cuts is blocked, not failed", async () => {
  const config = makeDryConfig({ MAX_IMAGE_USD: "0.01", MAX_EPISODE_USD: "1", DAILY_BUDGET_USD: "1" });
  fixCharacterSheets(config.characterSheetDir);
  const audio = writeFakeAudio(config.rootDir);

  const [result] = await new Pipeline(config, undefined, {
    executeRender: false,
    notifier: () => undefined,
    imageModel: pricedModel(0.134),
  }).runOnce({ file: audio });

  assert.equal(result.status, "blocked", result.message);
  assert.equal(result.stages.illustrate, "예산 초과");
  assert.match(result.message, /이미지 상한/);

  const store = new StateStore(config.stateFile);
  assert.deepEqual(store.summary().files, { blocked: 1 });
  assert.ok(!existsSync(path.join(config.failedDir, path.basename(result.projectDir))), "blocked 는 failed/ 에 원본을 쌓지 않습니다");
});

test("illustrator re-throws the budget error instead of retrying three times", async () => {
  const config = makeConfig({ MAX_IMAGE_USD: "0.01", MAX_EPISODE_USD: "1", DAILY_BUDGET_USD: "1" });
  fixCharacterSheets(config.characterSheetDir);
  const project = makeProject(config.rootDir);
  const illustrator = new Illustrator(config, new StateStore(config.stateFile), pricedModel(0.134));

  await assert.rejects(
    () => illustrator.generate(project, fixtureEpisode()),
    (error: Error) => error instanceof BudgetExceededError && /이미지 상한/.test(error.message),
  );
});
