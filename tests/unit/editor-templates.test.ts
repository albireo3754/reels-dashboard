import test from "node:test";
import assert from "node:assert/strict";
import { defaultEditSettings } from "../../src/shared/editor";
import { validateEditSettings } from "../../src/shared/editor-model";
import {
  editorPresets,
  applyEditorPreset,
  isPresetSelected,
} from "../../src/features/editor-templates/model/presets";
import { settingsPatchSchema } from "../../src/entities/agent-session";

test("five preset choices preserve content, timing and independent layout", () => {
  const settings = defaultEditSettings(10);
  settings.place.name = "서울";
  settings.place.description = "함께 걷는 길";
  settings.place.offsetY = 0.02;
  settings.cover.hook = "함께 걷는\n가을 산책";
  settings.cover.time = 3.5;
  settings.cover.hookSize = 165;
  settings.cover.hookOffsetX = 0.01;
  settings.captions.items = [
    { id: "1", start: 1, end: 2, text: "걸어봤어요." },
  ];
  const before = structuredClone(settings);
  for (const preset of editorPresets) {
    const changed = applyEditorPreset(settings, preset);
    assert.equal(isPresetSelected(changed, preset), true);
    assert.deepEqual(changed.captions, before.captions);
    assert.equal(changed.place.name, before.place.name);
    assert.equal(changed.place.description, before.place.description);
    assert.equal(changed.cover.time, 3.5);
    assert.equal(changed.cover.hook, before.cover.hook);
    assert.equal(changed.place.offsetY, 0.02);
    assert.equal(changed.cover.hookOffsetX, 0.01);
    if (preset.target === "cover")
      assert.equal(changed.cover.hookSize, undefined);
    else assert.deepEqual(changed.cover, before.cover);
  }
  assert.deepEqual(settings, before);
});

test("offsets survive validation and UI/MCP accept only engine-compatible sizes", () => {
  const settings = defaultEditSettings(10);
  settings.place.offsetX = -0.02;
  settings.cover.placeOffsetY = 0.02;
  settings.cover.hookOffsetY = -0.03;
  settings.cover.hookSize = 165;
  assert.deepEqual(validateEditSettings(settings, 10), settings);
  assert.doesNotThrow(() =>
    settingsPatchSchema.parse({
      place: { offsetX: -0.02 },
      cover: { hookSize: 165, hookOffsetY: -0.03 },
    }),
  );
  for (const value of [0, 186, 1.5, NaN]) {
    settings.cover.hookSize = value;
    assert.throws(() => validateEditSettings(settings, 10));
    assert.throws(() =>
      settingsPatchSchema.parse({ cover: { hookSize: value } }),
    );
  }
  delete settings.cover.hookSize;
  settings.place.offsetX = Infinity;
  assert.throws(() => validateEditSettings(settings, 10));
});
