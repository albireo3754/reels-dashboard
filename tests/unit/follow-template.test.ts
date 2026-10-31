import test from "node:test";
import assert from "node:assert/strict";
import { defaultEditSettings, followCoverDefaults } from "../../src/shared/editor";
import { validateEditSettings } from "../../src/shared/editor-model";
import { applyEditorPreset, editorPresets } from "../../src/features/editor-templates/model/presets";
import { patchProject, settingsPatchSchema } from "../../src/entities/agent-session";

test("follow card seeds only an empty message and needs no place for PNG output", () => {
  const initial = defaultEditSettings(10);
  const preset = editorPresets.find((p) => p.id === "6")!;
  const settings = applyEditorPreset(initial, preset);
  assert.equal(settings.cover.hook, followCoverDefaults.hook);
  assert.equal(initial.cover.hook, "");
  assert.deepEqual(settings.place, initial.place);
  assert.deepEqual(settings.captions, initial.captions);
  assert.doesNotThrow(() => validateEditSettings(settings, 10, "cover"));
  assert.throws(() => validateEditSettings(settings, 10, "video"), /장소명/);
  assert.throws(() => validateEditSettings(settings, 10, "export"), /장소명/);
  settings.cover.hook = "우리의 다음 여행\n함께 준비해요";
  settings.cover.followCta = "다음 정보도 받아보세요";
  settings.cover.followSignature = "@travel_notes 🌹";
  settings.cover.followDarkness = .42;
  assert.deepEqual(validateEditSettings(settings, 10, "cover"), settings);
  assert.equal(applyEditorPreset(settings, preset).cover.hook, settings.cover.hook);
});

test("follow fields are validated and revision-checked patches preserve unrelated settings", () => {
  const project = {
    schemaVersion: 1 as const, id: "source", updatedAt: "2026-10-29T00:00:00.000Z",
    source: { id: "source", name: "test.mp4", duration: 10, width: 720, height: 1280, hdr: false, hasAudio: false, videoURL: "" },
    settings: defaultEditSettings(10),
  };
  const patch = settingsPatchSchema.parse({ cover: {
    template: "rosy-follow", hook: "새로운 정보\n함께 봐요",
    followCta: "팔로우해 주세요!", followSignature: "@travel_notes", followDarkness: .4,
  } });
  const changed = patchProject(project, project.updatedAt, patch);
  assert.deepEqual(changed.settings.place, project.settings.place);
  assert.deepEqual(changed.settings.captions, project.settings.captions);
  assert.doesNotThrow(() => validateEditSettings(changed.settings, 10, "cover"));
  assert.throws(() => patchProject(project, "old", patch), /STALE_PROJECT/);
  assert.throws(() => settingsPatchSchema.parse({cover:{followDarkness:.9}}));
  for (const bad of ["", "@a\nb", "한글계정", "@" + "a".repeat(31)]) {
    const value = structuredClone(changed.settings); value.cover.followSignature = bad;
    assert.throws(() => validateEditSettings(value, 10, "cover"));
  }
  const value = structuredClone(changed.settings); value.cover.followCta = "두 줄\n문구";
  assert.throws(() => validateEditSettings(value, 10, "cover"), /한 줄/);
});
