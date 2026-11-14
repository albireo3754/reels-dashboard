import { z } from "zod";
const projectId = z.string().min(1).max(160);
export const selectionQuery = z.strictObject({ projectId });
export const selectionExecute = z.strictObject({ projectId, expectedRevision: z.number().int().min(0) });
export const selectionUpdate = z.strictObject({
  projectId, expectedRevision: z.number().int().min(0),
  candidate: z.strictObject({ sampleId: z.string(), usable: z.boolean(), reason: z.string().min(1).max(2000) }).optional(),
  representative: z.strictObject({ groupId: z.string(), sampleId: z.string(), reason: z.string().min(1).max(2000) }).optional(),
  usage: z.strictObject({ sampleId: z.string(), contentId: z.string().min(1), editId: z.string().optional(), used: z.boolean() }).optional(),
}).refine(v => Number(!!v.candidate) + Number(!!v.representative) + Number(!!v.usage) === 1);
export interface SelectionDocument {
  schemaVersion: 1; projectId: string; revision: number; analysisRevision?: number;
  candidates: { sampleId: string; usable: boolean; reason: string; human: boolean }[];
  groups: { id: string; sampleIds: string[]; representative: string; reason: string; human: boolean }[];
  usage: { sampleId: string; contentId: string; editId?: string }[];
}
export interface SelectionPort { search(value: unknown): Promise<unknown>; execute(value: unknown): Promise<unknown>; update(value: unknown): Promise<unknown> }
