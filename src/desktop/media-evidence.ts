import { createHash } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "../shared/lib/fs";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  analysisContext,
  analysisFields,
  type AnalysisFields,
  type AnalysisSample,
} from "../shared/media-analysis";
import type { ImageAnalyzer } from "./analysis-provider";

const absolutePath = z
  .string()
  .min(1)
  .refine(path.isAbsolute, "Absolute path required");
const identity = z.string().min(1).max(200);
export const evidenceManifest = z.strictObject({
  version: z.literal(1),
  projectId: identity,
  title: z.string().min(1).max(2000),
  context: analysisContext,
  request: z.string().min(1).max(3000),
  captures: z
    .array(z.strictObject({ id: identity, sourcePath: absolutePath }))
    .min(1),
  images: z
    .array(
      z.strictObject({
        id: identity,
        captureId: identity,
        path: absolutePath,
        time: z.number().nonnegative().nullable(),
        kind: z.enum(["photo", "video-frame"]),
        sourceLabel: z.string().max(2000).optional(),
      }),
    )
    .min(1),
});
export type EvidenceManifest = z.infer<typeof evidenceManifest>;
type FileVersion = { size: number; mtimeMs: number };
export type PreparedEvidence = {
  manifest: EvidenceManifest;
  fingerprint: string;
  captures: (EvidenceManifest["captures"][number] & { version: FileVersion })[];
  images: (EvidenceManifest["images"][number] & { sha256: string })[];
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function fileVersion(file: string): Promise<FileVersion> {
  const value = await stat(file);
  if (!value.isFile()) throw new Error(`Not a file: ${file}`);
  return { size: value.size, mtimeMs: value.mtimeMs };
}
async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function uniqueIds(items: { id: string }[], label: string) {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error(`Duplicate ${label} ID`);
}
/** Validate the complete inventory before any provider invocation. No editorial selection occurs here. */
export async function prepareEvidence(
  input: unknown,
): Promise<PreparedEvidence> {
  const manifest = evidenceManifest.parse(input);
  uniqueIds(manifest.captures, "capture");
  uniqueIds(manifest.images, "image");
  const captureIds = new Set(manifest.captures.map((capture) => capture.id));
  const represented = new Set<string>();
  for (const image of manifest.images) {
    if (!captureIds.has(image.captureId))
      throw new Error(`Unknown capture: ${image.captureId}`);
    if ((image.kind === "photo") !== (image.time === null))
      throw new Error(
        `Photo time must be null; video-frame time is required: ${image.id}`,
      );
    represented.add(image.captureId);
  }
  const missing = manifest.captures.filter(
    (capture) => !represented.has(capture.id),
  );
  if (missing.length)
    throw new Error(
      `Captures without images: ${missing.map((capture) => capture.id).join(", ")}`,
    );
  const captures: PreparedEvidence["captures"] = [];
  for (const capture of manifest.captures)
    captures.push({
      ...capture,
      version: await fileVersion(capture.sourcePath),
    });
  const images: PreparedEvidence["images"] = [];
  for (const image of manifest.images) {
    await fileVersion(image.path);
    images.push({ ...image, sha256: await fileHash(image.path) });
  }
  return {
    manifest,
    captures,
    images,
    fingerprint: digest(JSON.stringify({ manifest, captures, images })),
  };
}

const writeJson = (file: string, value: unknown) =>
  writeJsonAtomic(file, value, { mode: 0o600 });
const readJson = (file: string): Promise<unknown | undefined> =>
  readJsonFile<unknown>(file, (value) => value, () => undefined);
const savedBatch = z.strictObject({
  fingerprint: z.string(),
  provider: z.string(),
  batchKey: z.string(),
  analyzedAt: z.string(),
  results: z.array(
    z.strictObject({
      id: identity,
      sha256: z.string(),
      fields: analysisFields,
    }),
  ),
});
type SavedBatch = z.infer<typeof savedBatch>;
export interface EvidenceOptions {
  checkOnly?: boolean;
  batchSize?: number;
  concurrency?: number;
  onProgress?: (progress: {
    completedBatches: number;
    totalBatches: number;
    failedBatches: number;
  }) => void;
}
export async function analyzeEvidence(
  input: unknown,
  outputDir: string,
  analyzer: ImageAnalyzer,
  options: EvidenceOptions = {},
) {
  const batchSize = z
    .number()
    .int()
    .min(1)
    .max(8)
    .parse(options.batchSize ?? 8);
  const concurrency = z
    .number()
    .int()
    .min(1)
    .max(3)
    .parse(options.concurrency ?? 2);
  const prepared = await prepareEvidence(input);
  const { manifest, fingerprint, images, captures } = prepared;
  const output = path.resolve(outputDir);
  const previous = (await readJson(path.join(output, "input.json"))) as
    | PreparedEvidence
    | undefined;
  if (previous && previous.fingerprint !== fingerprint)
    throw new Error(
      "Evidence fingerprint changed; use a different output directory",
    );
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeJson(path.join(output, "input.json"), prepared);
  if (options.checkOnly) {
    const checked = {
      mode: "check-only",
      status: "checked",
      fingerprint,
      analysisComplete: false,
      inputPass: true,
      expected: images.length,
      resolved: images.length,
      missing: [],
      failed: [],
      inputChanged: [] as string[],
      expectedCaptures: captures.length,
      resolvedCaptures: captures.length,
    };
    // Do not replace a completed analysis coverage report during a later input-only check.
    await writeJson(path.join(output, "input-check.json"), checked);
    return checked;
  }
  const batchDir = path.join(output, "batches");
  await mkdir(batchDir, { recursive: true, mode: 0o700 });
  const batches: (typeof images)[] = [];
  for (let offset = 0; offset < images.length; offset += batchSize)
    batches.push(images.slice(offset, offset + batchSize));
  const commonContext = {
    projectId: manifest.projectId,
    title: manifest.title,
    dateBasis:
      "Use only explicit visit/capture facts in context; do not infer capture date",
    context: manifest.context,
  };
  const results = new Map<
    string,
    { fields: AnalysisFields; analyzedAt: string }
  >();
  const failed = new Map<string, string>();
  let completedBatches = 0,
    failedBatches = 0,
    next = 0;
  // Serialize shared progress writes while separate providers work concurrently.
  let progressWrite = Promise.resolve();
  const progress = () => {
    const snapshot = {
      completedBatches,
      totalBatches: batches.length,
      failedBatches,
    };
    progressWrite = progressWrite.then(() =>
      writeJson(path.join(output, "progress.json"), {
        mode: "analysis",
        status: "running",
        fingerprint,
        ...snapshot,
      }),
    );
    options.onProgress?.(snapshot);
    return progressWrite;
  };
  await progress();
  const workers = Array.from(
    { length: Math.min(concurrency, batches.length) },
    async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const batchKey = digest(
          JSON.stringify({
            fingerprint,
            provider: analyzer.id,
            ids: batch.map((image) => image.id),
          }),
        );
        const batchFile = path.join(batchDir, `${batchKey}.json`);
        try {
          const cached = await readJson(batchFile);
          let saved: SavedBatch;
          if (cached !== undefined) {
            saved = savedBatch.parse(cached);
            if (
              saved.fingerprint !== fingerprint ||
              saved.provider !== analyzer.id ||
              saved.batchKey !== batchKey ||
              saved.results.length !== batch.length ||
              saved.results.some(
                (result, index) =>
                  result.id !== batch[index].id ||
                  result.sha256 !== batch[index].sha256,
              )
            )
              throw new Error("Cached batch identity mismatch");
          } else {
            const samples: AnalysisSample[] = batch.map((image) => {
              const capture = captures.find(
                (item) => item.id === image.captureId,
              )!;
              return {
                id: image.id,
                sourcePath: capture.sourcePath,
                sourceVersion: JSON.stringify(capture.version),
                imagePath: image.path,
                kind: image.kind,
                time: image.time,
              };
            });
            const context = JSON.stringify({
              ...commonContext,
              imageSources: batch.map((image) => ({
                id: image.id,
                captureId: image.captureId,
                sourcePath: captures.find(
                  (capture) => capture.id === image.captureId,
                )!.sourcePath,
                sourceLabel: image.sourceLabel,
                time: image.time,
                kind: image.kind,
              })),
            });
            const fields = await analyzer.analyze(
              samples,
              context,
              manifest.request,
            );
            if (fields.length !== batch.length)
              throw new Error("Analyzer result count mismatch");
            saved = savedBatch.parse({
              fingerprint,
              provider: analyzer.id,
              batchKey,
              analyzedAt: new Date().toISOString(),
              results: batch.map((image, index) => ({
                id: image.id,
                sha256: image.sha256,
                fields: fields[index],
              })),
            });
            // Never persist a successful batch for images that changed during its analysis.
            for (const image of batch)
              if ((await fileHash(image.path)) !== image.sha256)
                throw new Error("Analysis image changed");
            await writeJson(batchFile, saved);
          }
          for (const result of saved.results)
            results.set(result.id, {
              fields: result.fields,
              analyzedAt: saved.analyzedAt,
            });
          completedBatches++;
        } catch {
          // Provider stderr/context must not leak into logs. Details remain bounded to attributable IDs.
          for (const image of batch)
            failed.set(
              image.id,
              "Batch analysis or saved-result validation failed",
            );
          failedBatches++;
        }
        await progress();
      }
    },
  );
  await Promise.all(workers);
  const inputChanged: string[] = [];
  for (const capture of captures) {
    try {
      if (
        JSON.stringify(await fileVersion(capture.sourcePath)) !==
        JSON.stringify(capture.version)
      )
        inputChanged.push(capture.id);
    } catch {
      inputChanged.push(capture.id);
    }
  }
  for (const image of images) {
    try {
      if ((await fileHash(image.path)) !== image.sha256)
        inputChanged.push(image.id);
    } catch {
      inputChanged.push(image.id);
    }
  }
  const missing = images
    .filter((image) => !results.has(image.id) && !failed.has(image.id))
    .map((image) => image.id);
  const resolvedCaptures = captures.filter((capture) =>
    images
      .filter((image) => image.captureId === capture.id)
      .every((image) => results.has(image.id)),
  ).length;
  const pass =
    missing.length === 0 &&
    failed.size === 0 &&
    inputChanged.length === 0 &&
    results.size === images.length;
  const coverage = {
    mode: "analysis",
    status: pass ? "completed" : "failed",
    fingerprint,
    provider: analyzer.id,
    pass,
    analysisComplete: pass,
    expected: images.length,
    resolved: results.size,
    missing,
    failed: [...failed].map(([id, message]) => ({ id, message })),
    inputChanged,
    expectedCaptures: captures.length,
    resolvedCaptures,
  };
  const resultDocument = {
    version: 1,
    fingerprint,
    provider: analyzer.id,
    projectId: manifest.projectId,
    context: manifest.context,
    request: manifest.request,
    images: images.map((image) => ({
      ...image,
      sourcePath: captures.find((capture) => capture.id === image.captureId)!
        .sourcePath,
      status: results.has(image.id) ? "resolved" : "failed",
      ...results.get(image.id),
    })),
  };
  const resultsPath = path.join(output, "results.json");
  await writeJson(resultsPath, resultDocument);
  await writeFile(
    path.join(output, "metadata-table.md"),
    renderEvidenceMetadataTable(resultDocument, resultsPath),
    { mode: 0o600 },
  );
  await writeJson(path.join(output, "coverage.json"), coverage);
  await writeJson(path.join(output, "progress.json"), {
    ...coverage,
    completedBatches,
    totalBatches: batches.length,
    failedBatches,
  });
  return coverage;
}

const tableInput = z
  .object({
    projectId: z.string().optional(),
    images: z.array(
      z
        .object({
          id: identity,
          captureId: identity,
          sourcePath: absolutePath,
          path: absolutePath,
          kind: z.enum(["photo", "video-frame"]),
          time: z.number().nonnegative().nullable(),
          status: z.string().min(1),
          sha256: z.string().optional(),
          sourceLabel: z.string().optional(),
          fields: analysisFields.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Escape untrusted metadata without allowing pipes/newlines/HTML to create new rows or cells. */
function tableText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]`*_])/g, "\\$1")
    .replace(/\r\n?|\n/g, "<br>");
}
function tableLink(file: string, label: string): string {
  // Absolute local Markdown links, including filenames containing whitespace or delimiters.
  const target = file
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `[${tableText(label)}](<${target}>)`;
}
function tableArray(values: string[] | undefined): string {
  return values === undefined
    ? "미제공"
    : values.length
      ? values.map(tableText).join("<br>")
      : "[]";
}

/** Every input image becomes exactly one row; editorial selection consumes this complete table later. */
export function renderEvidenceMetadataTable(
  input: unknown,
  resultsJsonPath: string,
): string {
  const document = tableInput.parse(input);
  uniqueIds(document.images, "image");
  if (!path.isAbsolute(resultsJsonPath))
    throw new Error("Results JSON path must be absolute");
  const failed = document.images.filter(
    (image) => image.status === "failed",
  ).length;
  const unresolved = document.images.filter(
    (image) => image.status !== "resolved",
  ).length;
  const columns = [
    "imageId",
    "상태",
    "captureId / 원본파일",
    "종류 / 시각(초)",
    "실제 이미지",
    "description",
    "tags",
    "OCR",
    "contextNotes — 사용자 확인·기록 맥락",
    "uncertainties",
    "faceRegions — 후보",
    "sourceLabel",
    "SHA-256",
  ];
  const lines = [
    `# 이미지 메타데이터 — 전체 입력 ${document.images.length}행 · 실패 ${failed}행`,
    "",
    `범위: 결과 JSON의 images 전체 ${document.images.length}개. 미해결 ${unresolved}개. 편집용 선별 전의 전체 입력 표입니다.`,
    "",
    `원본 데이터: ${tableLink(resultsJsonPath, "results.json — 전체 필드와 출처")}`,
    "",
    "contextNotes는 모델이 기록과 사용자 맥락을 연결해 작성한 설명입니다. 얼굴 영역은 검토가 필요한 후보입니다. 실패·미제공 값은 추정해 채우지 않습니다.",
    "",
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const image of document.images) {
    const fields = image.fields;
    const cells = [
      tableText(image.id),
      tableText(image.status),
      `${tableText(image.captureId)}<br>${tableLink(image.sourcePath, image.sourcePath)}`,
      `${image.kind}<br>${image.time === null ? "해당 없음" : image.time}`,
      tableLink(image.path, image.path),
      fields ? tableText(fields.description) : "미분석",
      fields ? tableArray(fields.tags) : "미분석",
      fields ? tableArray(fields.ocr) : "미분석",
      fields ? tableArray(fields.contextNotes) : "미분석",
      fields ? tableArray(fields.uncertainties) : "미분석",
      fields?.faceRegions === undefined
        ? "미제공"
        : tableText(JSON.stringify(fields.faceRegions)),
      image.sourceLabel === undefined ? "미제공" : tableText(image.sourceLabel),
      image.sha256 === undefined ? "미제공" : tableText(image.sha256),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
