import { createHash } from "node:crypto";

export const sha256Hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
/** Persisted media source version; analysis results and mosaic plans compare against it. */
export const sourceVersion = (info: { size: number; mtimeMs: number }) =>
  sha256Hex(`${info.size}:${info.mtimeMs}`);
