import { followCoverDefaults, type EditSettings } from "./editor";
/** Limits shared by editor validation and the agent settings patch schema. */
export const EDIT_LIMITS = {
  placeName: 200,
  placeDescription: 300,
  showDuring: 400,
  captionId: 100,
  captionText: 1000,
  maxCaptions: 300,
  hook: 600,
  followCta: 100,
  followSignature: 80,
  placeSize: { min: 0.005, max: 0.2 },
  captionFontSizeRatio: { min: 0.005, max: 0.082 },
  captionY: { min: 0.2, max: 0.79 },
  hookSize: { min: 1, max: 185 },
  followDarkness: { min: 0, max: 0.85 },
} as const;
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 2000) => {
  if (typeof v !== "string" || v.length > max || v.includes("\0"))
    throw new Error("편집 문구 형식을 확인해주세요.");
  return v;
};
const num = (v: unknown, min: number, max: number) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new Error("편집 숫자가 허용 범위를 벗어났어요.");
  return v;
};
const bool = (v: unknown) => {
  if (typeof v !== "boolean") throw new Error("배치 옵션을 확인해주세요.");
  return v;
};
export function validateEditSettings(
  value: unknown,
  duration: number,
  mode: "draft" | "video" | "cover" | "export" = "draft",
): EditSettings {
  if (
    !obj(value) ||
    !obj(value.place) ||
    !obj(value.captions) ||
    !obj(value.cover)
  )
    throw new Error("편집 설정 형식이 올바르지 않아요.");
  const p = value.place,
    c = value.captions,
    h = value.cover;
  if (
    !["none", "tape", "rectangle"].includes(String(p.material)) ||
    !["rosy-auto", "rosy-large", "rosy-follow"].includes(String(h.template))
  )
    throw new Error("알 수 없는 편집 템플릿이에요.");
  if (!Array.isArray(c.items) || c.items.length > EDIT_LIMITS.maxCaptions)
    throw new Error("자막은 최대 300개까지 사용할 수 있어요.");
  const result: EditSettings = {
    place: {
      useDefaultPosition: bool(p.useDefaultPosition),
      name: str(p.name, EDIT_LIMITS.placeName),
      description: str(p.description, EDIT_LIMITS.placeDescription),
      material: p.material as EditSettings["place"]["material"],
      x: num(p.x, 0, 1),
      y: num(p.y, 0, 1),
      ...optionalOffsets(p, ["offsetX", "offsetY"]),
      size: num(p.size, EDIT_LIMITS.placeSize.min, EDIT_LIMITS.placeSize.max),
      persistent: bool(p.persistent),
      showDuring: str(p.showDuring, EDIT_LIMITS.showDuring),
    },
    captions: {
      fontSizeRatio: num(c.fontSizeRatio, EDIT_LIMITS.captionFontSizeRatio.min, EDIT_LIMITS.captionFontSizeRatio.max),
      y: num(c.y, EDIT_LIMITS.captionY.min, EDIT_LIMITS.captionY.max),
      items: c.items.map((v) => {
        if (!obj(v)) throw new Error("자막 형식을 확인해주세요.");
        return {
          id: str(v.id, EDIT_LIMITS.captionId),
          start: num(v.start, 0, duration),
          end: num(v.end, 0, duration),
          text: str(v.text, EDIT_LIMITS.captionText),
        };
      }),
    },
    cover: {
      useDefaultPosition: bool(h.useDefaultPosition),
      time: num(h.time, 0, Math.max(0, duration - 0.001)),
      hook: str(h.hook, EDIT_LIMITS.hook),
      template: h.template as EditSettings["cover"]["template"],
      x: num(h.x, 0, 1),
      y: num(h.y, 0, 1),
      placeX: num(h.placeX, 0, 1),
      placeY: num(h.placeY, 0, 1),
      ...optionalOffsets(h, [
        "hookOffsetX",
        "hookOffsetY",
        "placeOffsetX",
        "placeOffsetY",
      ]),
      ...(h.hookSize === undefined ? {} : { hookSize: hookSize(h.hookSize) }),
      ...(h.followCta === undefined
        ? {}
        : { followCta: str(h.followCta, EDIT_LIMITS.followCta) }),
      ...(h.followSignature === undefined
        ? {}
        : { followSignature: str(h.followSignature, EDIT_LIMITS.followSignature) }),
      ...(h.followDarkness === undefined
        ? {}
        : { followDarkness: num(h.followDarkness, EDIT_LIMITS.followDarkness.min, EDIT_LIMITS.followDarkness.max) }),
    },
  };
  if (mode !== "draft") {
    if (
      (mode !== "cover" || result.cover.template !== "rosy-follow") &&
      !result.place.name.trim()
    )
      throw new Error("장소명을 입력해주세요.");
    if (mode === "video" || mode === "export") {
      if (result.place.material !== "none" && !result.place.description.trim())
        throw new Error("장소 설명을 입력해주세요.");
      let end = 0;
      for (const cue of result.captions.items) {
        if (cue.start < end || cue.end <= cue.start || cue.end > duration)
          throw new Error(
            "자막 구간은 겹치지 않게 영상 길이 안에서 정해주세요.",
          );
        if (!cue.text.trim() || cue.text.split("\n").length > 2)
          throw new Error("자막은 비어 있지 않은 한두 줄이어야 해요.");
        end = cue.end;
      }
    }
    if (mode === "cover" || mode === "export") {
      const lines = result.cover.hook.replaceAll("|", "\n").split("\n");
      if (lines.length !== 2 || lines.some((v) => !v.trim()))
        throw new Error("표지 훅을 두 줄로 입력해주세요.");
      if (result.cover.template === "rosy-follow") {
        const cta = result.cover.followCta ?? followCoverDefaults.cta;
        const signature =
          result.cover.followSignature ?? followCoverDefaults.signature;
        if (!cta.trim() || /[\r\n]/.test(cta))
          throw new Error("팔로우 문구는 한 줄로 입력해주세요.");
        if (!/^@?[A-Za-z0-9_.]{1,30}(?: 🌹)?$/.test(signature))
          throw new Error(
            "서명은 영문 계정명으로 입력해주세요. 끝에 🌹를 붙일 수 있어요.",
          );
      }
    }
  }
  return result;
}

function optionalOffsets(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, num(value[key], -1, 1)]),
  );
}
function hookSize(value: unknown) {
  const size = num(value, EDIT_LIMITS.hookSize.min, EDIT_LIMITS.hookSize.max);
  if (!Number.isInteger(size))
    throw new Error("표지 글자 크기는 1~185 사이 정수로 입력해주세요.");
  return size;
}
/** Switching cover template drops a manual hook size and seeds the follow hook when empty. */
export function selectCoverTemplate(
  settings: EditSettings,
  template: EditSettings["cover"]["template"],
): EditSettings {
  const { hookSize: _override, ...cover } = settings.cover;
  return {
    ...settings,
    cover: {
      ...cover,
      template,
      ...(template === "rosy-follow" && !cover.hook.trim()
        ? { hook: followCoverDefaults.hook }
        : {}),
    },
  };
}
