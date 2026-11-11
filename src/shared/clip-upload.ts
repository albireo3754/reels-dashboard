import { z } from "zod";
import { localPathSchema } from "./local-resources";
import { dashboardRevision } from "./production-project";

export const coverPreferencesSchema = z.strictObject({
  signature: z.string().regex(/^@?[A-Za-z0-9_.]{1,30}(?: 🌹)?$/),
});
export const defaultCoverPreferences = { signature: "@your_account 🌹" };
export type CoverPreferences = z.infer<typeof coverPreferencesSchema>;
export interface CoverPreferencesBridge {
  get(): Promise<CoverPreferences>;
  set(input: CoverPreferences): Promise<CoverPreferences>;
}
export const clipUploadInput = z.strictObject({
  projectId: z.string().min(1).max(160),
  expectedUpdatedAt: dashboardRevision,
  videoPath: localPathSchema.optional(),
  coverPath: localPathSchema.optional(),
  description: z
    .string()
    .min(1)
    .max(20000)
    .refine((v) => !!v.trim() && !v.includes("\0")),
});
export type ClipUploadInput = z.infer<typeof clipUploadInput>;
export interface UploadFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface ClipUploadResult {
  projectId: string;
  createdAt: string;
  directory: string;
  files: { video: UploadFile; cover: UploadFile; description: UploadFile };
  receipt: UploadFile;
  sources: { video: string; cover: string };
  cleanup: "temporary-manual-or-os";
}
export interface ClipUploadBridge {
  create(input: ClipUploadInput): Promise<ClipUploadResult>;
}
