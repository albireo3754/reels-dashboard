import { z } from "zod";
import { dashboardRevision } from "./production-project";
import { sourceBoardSchema } from "../../packages/briefing/model";
export { sourceBoardSchema, type SourceBoard } from "../../packages/briefing/model";

export const getSourceBoardSchema = z.strictObject({ projectId: z.string().min(1).max(160) });
export const setSourceBoardSchema = getSourceBoardSchema.extend({
  expectedUpdatedAt: dashboardRevision, board: sourceBoardSchema.nullable(),
});
export type SetSourceBoardInput = z.infer<typeof setSourceBoardSchema>;
