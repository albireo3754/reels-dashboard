import { followCoverDefaults, type EditSettings } from "../../../shared/editor";

// Stable numbers match the bundled reels_editor/app/presets.py catalogue.
export const editorPresets = [
  {
    id: "1",
    target: "video",
    title: "장소 핀만",
    note: "장소명을 가로 중앙에",
    material: "none",
  },
  {
    id: "2",
    target: "video",
    title: "핀 + 설명 테이프",
    note: "명조체 · 아이보리 종이 테이프",
    material: "tape",
  },
  {
    id: "3",
    target: "video",
    title: "핀 + 설명 사각 바",
    note: "고딕체 · 흰 글씨 · 검은 바",
    material: "rectangle",
  },
  {
    id: "4",
    target: "cover",
    title: "표지 자동 크기",
    note: "긴 줄 폭에 맞춰 두 줄 함께 조절",
    template: "rosy-auto",
  },
  {
    id: "5",
    target: "cover",
    title: "표지 185px 고정",
    note: "2160px 영상폭 기준 · 두 줄 같은 크기",
    template: "rosy-large",
  },
  {
    id: "6",
    target: "cover",
    title: "서명 있는 팔로우 마지막 장",
    note: "어두운 사진 · 팔로우 문구 · 분홍 서명",
    template: "rosy-follow",
  },
] as const;
export type EditorPreset = (typeof editorPresets)[number];
export function applyEditorPreset(
  settings: EditSettings,
  preset: EditorPreset,
): EditSettings {
  if (preset.target === "video")
    return {
      ...settings,
      place: { ...settings.place, material: preset.material },
    };
  const { hookSize: _override, ...cover } = settings.cover;
  return {
    ...settings,
    cover: {
      ...cover,
      template: preset.template,
      ...(preset.template === "rosy-follow" && !cover.hook.trim()
        ? { hook: followCoverDefaults.hook }
        : {}),
    },
  };
}
export function isPresetSelected(
  settings: EditSettings,
  preset: EditorPreset,
): boolean {
  return preset.target === "video"
    ? settings.place.material === preset.material
    : settings.cover.template === preset.template &&
        settings.cover.hookSize === undefined;
}
