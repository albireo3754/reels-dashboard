import { z } from "zod";
export const analysisContext = z.strictObject({
  venue: z.string().max(2000).default(""),
  location: z.string().max(2000).default(""),
  visit: z.string().max(3000).default(""),
  menus: z.string().max(6000).default(""),
  surroundings: z.string().max(3000).default(""),
  notes: z.string().max(6000).default(""),
  sources: z.array(z.string().max(1000)).max(30).default([]),
});
export type AnalysisContext = z.infer<typeof analysisContext>;
export const faceRegion = z.strictObject({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1);
export const analysisFields = z.strictObject({
  usability: z.strictObject({ usable: z.boolean(), reason: z.string().min(1).max(1000) }).optional(),
  faceRegions: z.array(faceRegion).max(100).optional(),
  contextNotes: z.array(z.string().max(1000)).max(20).optional(),
  description: z.string().max(4000),
  tags: z.array(z.string().max(100)).max(40),
  ocr: z.array(z.string().max(1000)).max(50),
  uncertainties: z.array(z.string().max(1000)).max(30),
});
export type AnalysisFields = z.infer<typeof analysisFields>;
const analysisRevision = z
  .number()
  .int()
  .min(0)
  .describe("revision returned by search_analysis; stale revisions are rejected.");
export const analysisStart = z.strictObject({
  projectId: z.string().min(1).max(160),
  folder: z.string().startsWith("/").max(4096),
  provider: z.string().min(1).max(80).default("codex"),
  request: z
    .string()
    .max(3000)
    .default(
      "장면 설명, 검색 태그, 화면 글자와 확인이 필요한 사항을 한국어로 분석해주세요.",
    ),
  context: analysisContext.optional(),
  expectedRevision: analysisRevision.optional(),
  model: z.string().min(1).max(160).optional(),
  reasoning: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  force: z.boolean().default(false),
  maxFiles: z.number().int().min(1).max(200).default(100),
});
export const analysisQuery = z.strictObject({
  projectId: z.string().min(1).max(160),
  query: z.string().max(300).default(""),
});
export const analysisCorrection = z.strictObject({
  projectId: z.string().min(1).max(160),
  sampleId: z.string().min(1).max(100),
  expectedRevision: analysisRevision,
  fields: analysisFields.partial(),
});
export interface AnalysisSample {
  id: string;
  sourcePath: string;
  sourceVersion: string;
  kind: "photo" | "video-frame";
  time: number | null;
  imagePath: string;
}
export interface AnalysisUsage {
  inputTokens: number | null; cachedInputTokens: number | null;
  outputTokens: number | null; reasoningTokens: number | null;
  actualModel: string | null; actualReasoning: string | null;
  durationMs: number; imageCount: number;
}
export interface AnalysisResult {
  reuseKey?: string;
  sample: AnalysisSample;
  provider: string;
  runId: string;
  analyzedAt: string;
  fields: AnalysisFields;
}
export interface AnalysisRun {
  requestedModel?: string;
  requestedReasoning?: string;
  settingsDigest?: string;
  force?: boolean;
  skippedSamples?: number;
  calls?: AnalysisUsage[];
  usage?: AnalysisUsage;
  context?: AnalysisContext;
  promptVersion?: string;
  id: string;
  provider: string;
  request: string;
  folder: string;
  status: "running" | "completed" | "partial" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  totalFiles: number;
  processedFiles: number;
  analyzedSamples: number;
  errors: { sourcePath: string; message: string }[];
}
export interface AnalysisDocument {
  digestCache?: Record<string, { contentDigest: string; samples: AnalysisSample[]; duration?: number; width?: number; height?: number }>;
  context?: AnalysisContext;
  schemaVersion: 1;
  projectId: string;
  revision: number;
  runs: AnalysisRun[];
  results: AnalysisResult[];
  corrections: Record<string, Partial<AnalysisFields>>;
}
export interface AnalysisView extends AnalysisDocument {
  matches: (AnalysisResult & { effective: AnalysisFields })[];
}
export type MosaicRegion = z.infer<typeof faceRegion>;
export interface MosaicInput { projectId: string; sampleId: string; regions: MosaicRegion[]; blockSize: number }
export interface AnalysisBridge {
  mosaicSample(projectId: string, sampleId: string): Promise<string>;
  mosaicExport(input: MosaicInput): Promise<string | null>;
  providers(): Promise<{ id: string; label: string }[]>;
  start(input: z.input<typeof analysisStart>): Promise<AnalysisRun>;
  search(input: z.input<typeof analysisQuery>): Promise<AnalysisView>;
  correct(input: z.input<typeof analysisCorrection>): Promise<AnalysisView>;
}
