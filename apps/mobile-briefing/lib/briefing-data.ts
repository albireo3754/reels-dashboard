import type { Monitor, Progress } from "./monitor";
import type { RouteMapData } from "./route-map";
import type { PublishingCopy } from "./contracts";
export type Content = Progress & {
  id: string;
  title: string;
  date: string;
  date_basis: string;
  stage: string;
  next_action: string;
  public_url: string;
  publishing_copy?: PublishingCopy | null;
  route_map?: RouteMapData | null;
  route_map_status?: "ready" | "unavailable" | null;
};
export type Asset = {
  id: string;
  content_id: string;
  role: string;
  label: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  is_directory: number;
  available: number;
  item_count: number | null;
};
export type BriefingData = {
  monitor?: Monitor | null;
  source: { label: string; lastSeen: string; sourceUpdatedAt: string } | null;
  online: boolean;
  mediaEnabled: boolean;
  previewsEnabled?: boolean;
  syncedAt: string | null;
  contents: Content[];
  assets: Asset[];
};
