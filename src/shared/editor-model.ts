import type { EditSettings } from "./editor";
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
    !["rosy-auto", "rosy-large"].includes(String(h.template))
  )
    throw new Error("알 수 없는 편집 템플릿이에요.");
  if (!Array.isArray(c.items) || c.items.length > 300)
    throw new Error("자막은 최대 300개까지 사용할 수 있어요.");
  const result: EditSettings = {
    place: {
      useDefaultPosition: bool(p.useDefaultPosition),
      name: str(p.name, 200),
      description: str(p.description, 300),
      material: p.material as EditSettings["place"]["material"],
      x: num(p.x, 0, 1),
      y: num(p.y, 0, 1),
      size: num(p.size, 0.005, 0.2),
      persistent: bool(p.persistent),
      showDuring: str(p.showDuring, 400),
    },
    captions: {
      fontSizeRatio: num(c.fontSizeRatio, 0.005, 0.082),
      y: num(c.y, 0.2, 0.79),
      items: c.items.map((v) => {
        if (!obj(v)) throw new Error("자막 형식을 확인해주세요.");
        return {
          id: str(v.id, 100),
          start: num(v.start, 0, duration),
          end: num(v.end, 0, duration),
          text: str(v.text, 1000),
        };
      }),
    },
    cover: {
      useDefaultPosition: bool(h.useDefaultPosition),
      time: num(h.time, 0, Math.max(0, duration - 0.001)),
      hook: str(h.hook, 600),
      template: h.template as EditSettings["cover"]["template"],
      x: num(h.x, 0, 1),
      y: num(h.y, 0, 1),
      placeX: num(h.placeX, 0, 1),
      placeY: num(h.placeY, 0, 1),
      ...(h.hookSize === undefined
        ? {}
        : { hookSize: num(h.hookSize, 1, 400) }),
    },
  };
  if (mode !== "draft") {
    if (!result.place.name.trim()) throw new Error("장소명을 입력해주세요.");
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
    }
  }
  return result;
}
