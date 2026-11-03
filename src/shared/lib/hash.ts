import { createHash, type BinaryLike } from "node:crypto";

/** Hex SHA-256 digest used for content fingerprints, cache keys and integrity checks. */
export const sha256Hex = (data: BinaryLike) =>
  createHash("sha256").update(data).digest("hex");
