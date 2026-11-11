import { z } from "zod";
import { localPathSchema } from "./local-resources";

export const icloudPathsSchema = z
  .array(localPathSchema)
  .min(1)
  .max(100)
  .refine(
    (paths) =>
      new Set(paths).size === paths.length &&
      JSON.stringify(paths).length <= 8192,
    "Select distinct paths within the native request size limit.",
  );
export const icloudStatusInput = z.strictObject({ paths: icloudPathsSchema });
const outboundName = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (name) =>
      !name.startsWith(".") &&
      !/[\\/\u0000]/.test(name) &&
      name !== "receipt.json",
    "Use a visible filename, not a path.",
  );
export const outboundFileSchema = z.strictObject({
  name: outboundName,
  role: z.enum(["final", "cover", "document"]),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const outboundSchema = z.strictObject({
  directory: localPathSchema,
  generation: z.number().int().nonnegative(),
  files: z.array(outboundFileSchema).max(99),
  updatedAt: z.string().datetime(),
  receiptPath: localPathSchema.optional(),
});
export type ProjectOutbound = z.infer<typeof outboundSchema>;
export type OutboundFile = z.infer<typeof outboundFileSchema>;
export const configureOutboundInput = z.strictObject({
  projectId: z.string().min(1).max(160),
  expectedUpdatedAt: z.string().datetime(),
  directory: localPathSchema,
});
export const icloudDeliveryInput = z.strictObject({
  projectId: z.string().min(1).max(160),
  expectedUpdatedAt: z.string().datetime(),
  files: z
    .array(
      z.strictObject({
        sourcePath: localPathSchema,
        name: outboundName,
        role: z.enum(["final", "cover", "document"]),
      }),
    )
    .min(1)
    .max(99)
    .refine(
      (files) =>
        new Set(files.map((f) => f.name.normalize("NFC").toLowerCase()))
          .size === files.length,
      "Output filenames collide.",
    ),
});
export type ICloudDeliveryInput = z.infer<typeof icloudDeliveryInput>;
export interface ICloudUploadStatus {
  checkedAt: string;
  state: "completed" | "pending" | "failed";
  files: Array<{
    path: string;
    isUbiquitous: boolean;
    isUploaded: boolean;
    isUploading: boolean;
    isCurrent: boolean;
    uploadErrorDescription?: string | null;
  }>;
}
export interface ICloudDeliveryJob {
  id: string;
  projectId: string;
  destination: string;
  state: "copying" | "uploading" | "completed" | "failed";
  createdAt: string;
  paths: string[];
  receiptPath?: string;
  files?: OutboundFile[];
  upload?: ICloudUploadStatus;
  error?: string;
}
export interface ICloudBridge {
  configure(input: z.infer<typeof configureOutboundInput>): Promise<unknown>;
  list(): Promise<ICloudDeliveryJob[]>;
  start(input: ICloudDeliveryInput): Promise<ICloudDeliveryJob>;
  get(jobId: string): Promise<ICloudDeliveryJob>;
  status(paths: string[]): Promise<ICloudUploadStatus>;
}
