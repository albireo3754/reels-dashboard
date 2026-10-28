import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MobileBriefingStatus } from "../shared/mobile-briefing";

const statusSchema = z.object({
  siteUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname.endsWith(".chatgpt.site") &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    }),
  connected: z.boolean(),
  checkedAt: z.string().datetime(),
  syncedAt: z.string().datetime().nullable(),
  contentCount: z.number().int().nonnegative().nullable(),
  assetCount: z.number().int().nonnegative().nullable(),
});

export async function readMobileBriefingStatus(
  root: string,
  now = Date.now(),
): Promise<MobileBriefingStatus> {
  const empty = {
    siteUrl: null,
    checkedAt: null,
    syncedAt: null,
    contentCount: null,
    assetCount: null,
  };
  try {
    const raw = await readFile(
      path.join(root, "mobile-bridge/status.json"),
      "utf8",
    );
    if (raw.length > 8192) throw new Error("Invalid status");
    const status = statusSchema.parse(JSON.parse(raw));
    const age = now - Date.parse(status.checkedAt);
    return {
      state:
        status.connected && age >= -5000 && age < 45000
          ? "connected"
          : "offline",
      siteUrl: status.siteUrl,
      checkedAt: status.checkedAt,
      syncedAt: status.syncedAt,
      contentCount: status.contentCount,
      assetCount: status.assetCount,
    };
  } catch (error) {
    return {
      ...empty,
      state:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not-configured"
          : "unavailable",
    };
  }
}
