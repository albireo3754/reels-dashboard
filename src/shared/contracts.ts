import type { EditorBridge, AgentUiBridge } from "./editor";
export const commandMethods = [
  "status",
  "authorize",
  "sync",
  "groups.list",
  "groups.show",
  "groups.inspect",
  "decisions.validate",
  "export.plan",
  "export.apply",
  "move.plan",
  "move.apply",
] as const;
export type CommandMethod = (typeof commandMethods)[number];
export type Arguments = Record<string, string>;
export type Stage = "idea" | "selected" | "editing" | "review" | "published";
export interface Project {
  id: string;
  title: string;
  date: string;
  stage: Stage;
  nextAction: string;
  publicURL: string;
  shared: boolean;
}
export interface Dashboard {
  schemaVersion: 1;
  projects: Project[];
  updatedAt: string;
}
export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  projects: Omit<Project, "shared">[];
}
export interface OpenDocument {
  path: string;
  data: unknown;
}
export interface DashboardBridge {
  readonly workbench?: import("./workbench").WorkbenchBridge;
  readonly mobileBriefing?: {
    status(): Promise<import("./mobile-briefing").MobileBriefingStatus>;
    open(): Promise<void>;
  };
  readonly editor: EditorBridge;
  readonly agent?: AgentUiBridge;
  readonly mode: "desktop" | "demo" | "web";
  request<T = unknown>(method: CommandMethod, args?: Arguments): Promise<T>;
  saveDocument(name: string, data: unknown): Promise<string>;
  openDocument(): Promise<OpenDocument | null>;
  chooseDestination(): Promise<string | null>;
  imageURL(path: string): Promise<string>;
  loadDashboard(): Promise<Dashboard>;
  saveDashboard(value: Dashboard): Promise<void>;
  exportSnapshot(): Promise<string | null>;
  syncSnapshot(
    endpoint: string,
    token: string,
  ): Promise<{ generatedAt: string; count: number }>;
}
export interface Status {
  appVersion: string;
  protocolVersion: number;
  permission: string;
}
export interface Group {
  id: string;
  level: "coarse" | "fine";
  localDate: string;
  start?: string;
  end?: string;
  assetIDs: string[];
  warnings: string[];
}
export interface Groups {
  indexRunID: string;
  groups: Group[];
  level: "coarse" | "fine";
}
export interface Asset {
  id: string;
  capturedAt?: string;
  mediaKind: "photo" | "video";
  durationSeconds: number;
  pixelWidth: number;
  pixelHeight: number;
  hasLocation: boolean;
  publicFilename?: string;
}
export interface GroupDetail {
  indexRunID: string;
  group: Group;
  assets: Asset[];
}
export interface Decision {
  schemaVersion: 1;
  indexRunID: string;
  groupID: string;
  label: string;
  confidence: number;
  includedAssetIDs: string[];
  excludedAssetIDs: string[];
  evidenceReferences: string[];
  unknowns: string[];
}
export interface Sample {
  id: string;
  assetID: string;
  kind: string;
  relativePath: string;
  ocr: { text: string; confidence: number }[];
  privacyFlags: string[];
}
export interface Inspection {
  indexRunID: string;
  groupID: string;
  outputDirectory: string;
  sampleFiles: string[];
  evidenceJSON: string;
  summaryMarkdown: string;
  packet: { samples: Sample[]; assets: Asset[]; warnings: string[] };
  page: {
    pageNumber: number;
    pageSize: number;
    totalAssets: number;
    totalPages: number;
    assetIDs: string[];
    remainingAssetIDs: string[];
  };
}
export interface PlanEnvelope {
  plan: Record<string, unknown>;
  digest: string;
}
export const emptyDashboard = (): Dashboard => ({
  schemaVersion: 1,
  projects: [],
  updatedAt: new Date().toISOString(),
});
declare global {
  interface Window {
    reels?: DashboardBridge;
  }
}
