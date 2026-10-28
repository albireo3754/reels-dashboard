export interface MobileBriefingStatus {
  state: "connected" | "offline" | "unavailable" | "not-configured";
  siteUrl: string | null;
  checkedAt: string | null;
  syncedAt: string | null;
  contentCount: number | null;
  assetCount: number | null;
}
