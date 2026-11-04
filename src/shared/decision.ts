import { z } from "zod";
import type { Decision } from "./contracts";

const ids = z.array(z.string());

/** Shape check for a saved ModelDecision file before the native helper validates its contents. */
export const decisionFileSchema = z.object({
  schemaVersion: z.literal(1),
  indexRunID: z.string(),
  groupID: z.string(),
  label: z.string(),
  confidence: z.number(),
  includedAssetIDs: ids,
  excludedAssetIDs: ids,
  evidenceReferences: ids,
  unknowns: ids,
}) satisfies z.ZodType<Decision>;
