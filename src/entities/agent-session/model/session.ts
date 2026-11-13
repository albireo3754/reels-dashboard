import { z } from "zod";
import type { EditSettings, EditorProject } from "../../../shared/editor";
import { EDIT_LIMITS, validateEditSettings } from "../../../shared/editor-model";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !v.includes("\0"), "NUL is not allowed");
const ratio = z.number().min(0).max(1);
export const settingsPatchSchema = z.strictObject({
  place: z
    .strictObject({
      useDefaultPosition: z.boolean().optional(),
      name: text(EDIT_LIMITS.placeName).optional(),
      description: text(EDIT_LIMITS.placeDescription).optional(),
      material: z.enum(["none", "tape", "rectangle"]).optional(),
      x: ratio.optional(),
      y: ratio.optional(),
      offsetX: z.number().min(-1).max(1).optional(),
      offsetY: z.number().min(-1).max(1).optional(),
      size: z.number().min(EDIT_LIMITS.placeSize.min).max(EDIT_LIMITS.placeSize.max).optional(),
      persistent: z.boolean().optional(),
      showDuring: text(EDIT_LIMITS.showDuring).optional(),
    })
    .optional(),
  captions: z
    .strictObject({
      fontSizeRatio: z.number().min(EDIT_LIMITS.captionFontSizeRatio.min).max(EDIT_LIMITS.captionFontSizeRatio.max).optional(),
      y: z.number().min(EDIT_LIMITS.captionY.min).max(EDIT_LIMITS.captionY.max).optional(),
      items: z
        .array(
          z.strictObject({
            id: text(EDIT_LIMITS.captionId),
            start: z.number().min(0),
            end: z.number().min(0),
            text: text(EDIT_LIMITS.captionText),
          }),
        )
        .max(EDIT_LIMITS.maxCaptions)
        .optional(),
    })
    .optional(),
  cover: z
    .strictObject({
      useDefaultPosition: z.boolean().optional(),
      time: z.number().min(0).optional(),
      hook: text(EDIT_LIMITS.hook).optional(),
      template: z.enum(["rosy-auto", "rosy-large", "rosy-follow"]).optional(),
      x: ratio.optional(),
      y: ratio.optional(),
      placeX: ratio.optional(),
      placeY: ratio.optional(),
      hookOffsetX: z.number().min(-1).max(1).optional(),
      hookOffsetY: z.number().min(-1).max(1).optional(),
      placeOffsetX: z.number().min(-1).max(1).optional(),
      placeOffsetY: z.number().min(-1).max(1).optional(),
      hookSize: z.number().int().min(EDIT_LIMITS.hookSize.min).max(EDIT_LIMITS.hookSize.max).nullable().optional(),
      followCta: text(EDIT_LIMITS.followCta).optional(),
      followSignature: text(EDIT_LIMITS.followSignature).optional(),
      followDarkness: z.number().min(EDIT_LIMITS.followDarkness.min).max(EDIT_LIMITS.followDarkness.max).optional(),
    })
    .optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const contextSchema = z.strictObject({
  projectId: z.string().nullable(),
  dirty: z.boolean(),
  time: z.number().min(0),
  active: z.boolean(),
  busy: z.boolean(),
});
export type EditorContext = z.infer<typeof contextSchema>;
export class AgentSession {
  private value: EditorContext = {
    projectId: null,
    dirty: false,
    time: 0,
    active: false,
    busy: false,
  };
  update(value: unknown) {
    this.value = contextSchema.parse(value);
  }
  get context() {
    return { ...this.value };
  }
  assertWritable(projectId?: string) {
    if (
      (!projectId || this.value.projectId === projectId) &&
      (this.value.dirty || this.value.busy)
    )
      throw new Error(
        "EDITOR_BUSY: 앱의 편집을 저장하거나 진행 중인 작업을 마친 뒤 다시 요청해주세요.",
      );
  }
}
export function patchProject(
  project: EditorProject,
  expectedUpdatedAt: string,
  input: SettingsPatch,
): EditorProject {
  if (project.updatedAt !== expectedUpdatedAt)
    throw new Error(
      "STALE_PROJECT: 프로젝트를 다시 조회하고 변경 내용을 확인해주세요.",
    );
  const patch = settingsPatchSchema.parse(input);
  const settings = structuredClone(project.settings);
  if (patch.place) {
    Object.assign(settings.place, patch.place);
    if (
      (patch.place.x !== undefined || patch.place.y !== undefined) &&
      patch.place.useDefaultPosition === undefined
    )
      settings.place.useDefaultPosition = false;
  }
  if (patch.captions) Object.assign(settings.captions, patch.captions);
  if (patch.cover) {
    const { hookSize, ...rest } = patch.cover;
    Object.assign(settings.cover, rest);
    if (hookSize === null) delete settings.cover.hookSize;
    else if (hookSize !== undefined) settings.cover.hookSize = hookSize;
    if (
      [
        patch.cover.x,
        patch.cover.y,
        patch.cover.placeX,
        patch.cover.placeY,
      ].some((v) => v !== undefined) &&
      patch.cover.useDefaultPosition === undefined
    )
      settings.cover.useDefaultPosition = false;
  }
  return {
    ...project,
    settings: validateEditSettings(
      settings as EditSettings,
      project.source.duration,
    ),
  };
}
