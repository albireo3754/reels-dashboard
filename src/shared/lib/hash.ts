import { createHash, type BinaryLike } from "node:crypto";

/** Hex SHA-256 digest used for content fingerprints, cache keys and integrity checks. */
export const sha256Hex = (data: BinaryLike) =>
  createHash("sha256").update(data).digest("hex");
/** Persisted media source version; analysis results and mosaic plans compare against it. */
export const sourceVersion = (info: { size: number; mtimeMs: number }) =>
  sha256Hex(`${info.size}:${info.mtimeMs}`);
