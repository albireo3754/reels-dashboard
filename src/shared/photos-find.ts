import { z } from "zod";
import type { Arguments, Asset, CommandMethod, GroupDetail, Groups } from "./contracts";

export const photosFindInput = z.strictObject({
  date: z.iso.date(),
  mediaKind: z.enum(["all", "video", "photo"]).default("video"),
  minDuration: z.number().finite().min(0).optional(),
  maxDuration: z.number().finite().min(0).optional(),
  filename: z.string().trim().min(1).max(200).optional(),
}).refine(v => v.minDuration === undefined || v.maxDuration === undefined || v.minDuration <= v.maxDuration,
  "최소 길이는 최대 길이보다 클 수 없어요.")
  .refine(v => v.mediaKind === "video" || (v.minDuration === undefined && v.maxDuration === undefined),
    "길이 조건은 영상 검색에서만 사용할 수 있어요.");
export type PhotosFindInput = z.infer<typeof photosFindInput>;
export type FoundPhoto = Asset & { groupId: string; indexRunId: string };
export interface PhotosFindResult {
  date: string;
  groups: Groups;
  scannedCount: number;
  matches: FoundPhoto[];
}

/** One explicit local day, metadata only. Fails on incomplete/stale groups, never returns partial success. */
export async function findPhotos(
  request: (method: CommandMethod, args: Arguments) => Promise<unknown>,
  raw: unknown,
): Promise<PhotosFindResult> {
  const input = photosFindInput.parse(raw);
  const indexed = await request("sync", { date: input.date }) as { indexRunID: string };
  const groups = await request("groups.list", { level: "fine" }) as Groups;
  if (!indexed.indexRunID || groups.indexRunID !== indexed.indexRunID)
    throw new Error("stale-index-run: 촬영 날짜를 다시 검색해주세요.");
  const seen = new Set<string>();
  const matches: FoundPhoto[] = [];
  for (const group of groups.groups) {
    const detail = await request("groups.show", { id: group.id, "index-run": groups.indexRunID }) as GroupDetail;
    if (detail.indexRunID !== groups.indexRunID || detail.group.id !== group.id || detail.group.localDate !== input.date)
      throw new Error("stale-index-run: 검색 중 촬영 색인이 바뀌었어요. 다시 검색해주세요.");
    for (const asset of detail.assets) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      if (input.mediaKind !== "all" && asset.mediaKind !== input.mediaKind) continue;
      if (input.minDuration !== undefined && asset.durationSeconds < input.minDuration) continue;
      if (input.maxDuration !== undefined && asset.durationSeconds > input.maxDuration) continue;
      if (input.filename && !asset.publicFilename?.toLowerCase().includes(input.filename.toLowerCase())) continue;
      matches.push({ ...asset, groupId: group.id, indexRunId: groups.indexRunID });
    }
  }
  matches.sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? "") || a.id.localeCompare(b.id));
  return { date: input.date, groups, scannedCount: seen.size, matches };
}
