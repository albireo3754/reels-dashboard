import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { writeJsonAtomic } from "../shared/lib/fs";
import { sha256Hex } from "../shared/lib/hash";
import { analysisContext, type AnalysisFields } from "../shared/media-analysis";
import type { ImageAnalyzer } from "./analysis-provider";
import { analyzeEvidence, renderEvidenceMetadataTable, type EvidenceManifest } from "./media-evidence";
import { EVIDENCE_POINTER, manuscriptOverrides, readBlogProjects } from "./blog-projects";

const run = promisify(execFile);
const absolutePath = z.string().min(1).refine(path.isAbsolute, "Absolute path required");
const identity = z.string().min(1).max(200);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const FIELDS = ["description", "tags", "ocr", "contextNotes"] as const;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const CONVERTED_EXTENSIONS = new Set([".heic", ".heif"]);

const check = z.strictObject({
  name: z.string().min(1).max(300),
  captureIds: z.array(identity).optional(),
  imageIds: z.array(identity).optional(),
  fields: z.array(z.enum(FIELDS)).min(1).optional(),
  /** Pass when at least one row in scope contains every term. */
  includes: z.array(z.string().min(1)).optional(),
  /** Pass when no row in scope contains any term. */
  excludes: z.array(z.string().min(1)).optional(),
}).refine((c) => c.includes?.length || c.excludes?.length, "A check needs includes or excludes");

/** The only hand-written input. Everything after it is reproducible from this file. */
export const evidenceLoopSpec = z.strictObject({
  version: z.literal(1),
  projectId: identity,
  title: z.string().min(1).max(2000),
  context: analysisContext,
  request: z.string().min(1).max(3000),
  /** Private persistent folder: analysis and later links read these copies, never temporary paths. */
  archiveDir: absolutePath,
  captures: z.array(z.strictObject({
    id: identity,
    sourcePath: absolutePath,
    /** Facts about the capture, such as time and location, carried into every row's sourceLabel. */
    note: z.string().max(500).optional(),
    frames: z.strictObject({
      fps: z.number().positive().max(30),
      maxFrames: z.number().int().min(1).max(2000).optional(),
      width: z.number().int().min(64).max(8192).optional(),
    }).optional(),
  })).min(1),
  images: z.array(z.strictObject({
    captureId: identity,
    path: absolutePath,
    time: z.number().nonnegative().nullable(),
    kind: z.enum(["photo", "video-frame"]),
    sourceLabel: z.string().max(2000).optional(),
  })).default([]),
  excluded: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1).max(1000) })).default([]),
  /** Re-analyze only the named captures/images; earlier runs stay as they are. */
  corrections: z.array(z.strictObject({
    id: slug,
    reason: z.string().min(1).max(2000),
    context: analysisContext.optional(),
    request: z.string().min(1).max(3000).optional(),
    captureIds: z.array(identity).optional(),
    imageIds: z.array(identity).optional(),
  }).refine((c) => c.captureIds?.length || c.imageIds?.length, "A correction needs captureIds or imageIds")).default([]),
  checks: z.array(check).default([]),
});
export type EvidenceLoopSpec = z.infer<typeof evidenceLoopSpec>;
export type EvidenceRow = {
  id: string; captureId: string; path: string; sourcePath: string; kind: string; time: number | null;
  status: string; sha256?: string; sourceLabel?: string; fields?: AnalysisFields; analysisRun?: string;
};
export type EvidenceDocument = {
  version: number; fingerprint: string; provider: string; projectId: string; context: unknown; request: string;
  images: EvidenceRow[]; provenance?: unknown;
};

const writeJson = (file: string, value: unknown) => writeJsonAtomic(file, value, { mode: 0o600 });
const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;

/** Extraction is skipped when the same settings already produced frames, so reruns keep identical inputs. */
async function extractFrames(capture: EvidenceLoopSpec["captures"][number], archiveDir: string) {
  const frames = capture.frames!;
  const key = sha256Hex(JSON.stringify([capture.id, capture.sourcePath, frames])).slice(0, 16);
  const dir = path.join(archiveDir, ".frames", key), done = path.join(dir, "complete.json");
  const finished = await stat(done).then(() => true, () => false);
  if (!finished) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const filters = [`fps=${frames.fps}`, ...(frames.width ? [`scale=${frames.width}:-2`] : [])].join(",");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-i", capture.sourcePath, "-vf", filters, "-q:v", "2",
      ...(frames.maxFrames ? ["-frames:v", String(frames.maxFrames)] : []), path.join(dir, "frame_%06d.jpg")]);
    await writeJson(done, { sourcePath: capture.sourcePath, frames });
  }
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jpg")).sort();
  if (!names.length) throw new Error(`No frames extracted: ${capture.id}`);
  return names.map((name, index) => {
    const time = Number((index / frames.fps).toFixed(3));
    return { captureId: capture.id, path: path.join(dir, name), time, kind: "video-frame" as const, sourceLabel: `${capture.id} at ${time}s; ffmpeg fps=${frames.fps}${capture.note ? "; " + capture.note : ""}` };
  });
}
/** The analyzer reads JPEG; a HEIC original stays untouched and its derivative is labelled as one. */
async function convertedPhoto(file: string, archiveDir: string) {
  const key = sha256Hex(file).slice(0, 16);
  const dir = path.join(archiveDir, ".converted"), target = path.join(dir, key + ".jpg");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!await stat(target).then(() => true, () => false)) {
    const temporary = `${target}.${process.pid}.tmp.jpg`;
    await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", file, "--out", temporary]);
    await rename(temporary, target);
  }
  return target;
}

/** Builds the frozen manifest: extract frames, consolidate exact-byte copies only, retain every image. */
export async function assembleEvidence(specInput: unknown, outputDir: string) {
  const spec = evidenceLoopSpec.parse(specInput);
  await mkdir(spec.archiveDir, { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const entries = [...spec.images];
  for (const capture of spec.captures) {
    if (capture.frames) entries.push(...await extractFrames(capture, spec.archiveDir));
    else if (!entries.some((entry) => entry.captureId === capture.id)) {
      const extension = path.extname(capture.sourcePath).toLowerCase(), note = capture.note ? "; " + capture.note : "";
      if (IMAGE_EXTENSIONS.has(extension)) entries.push({ captureId: capture.id, path: capture.sourcePath, time: null, kind: "photo", sourceLabel: `${capture.id} original file${note}` });
      else if (CONVERTED_EXTENSIONS.has(extension)) entries.push({ captureId: capture.id, path: await convertedPhoto(capture.sourcePath, spec.archiveDir), time: null, kind: "photo", sourceLabel: `${capture.id} JPEG derivative of the HEIC original${note}` });
    }
  }
  const images: EvidenceManifest["images"] = [], seen = new Map<string, string>(), aliases = [];
  for (const entry of entries) {
    const extension = path.extname(entry.path).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`Unsupported image type: ${entry.path}`);
    const bytes = await readFile(entry.path), hash = sha256Hex(bytes);
    let id = seen.get(hash);
    if (!id) {
      id = "im-" + hash.slice(0, 20);
      seen.set(hash, id);
      const target = path.join(spec.archiveDir, id + extension);
      try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (sha256Hex(await readFile(target)) !== hash) throw new Error(`Archive file differs: ${target}`);
      }
      images.push({ ...entry, id, path: target });
    }
    aliases.push({ inputPath: entry.path, captureId: entry.captureId, time: entry.time, sha256: hash, resultId: id });
  }
  const manifest: EvidenceManifest = {
    version: 1, projectId: spec.projectId, title: spec.title, context: spec.context, request: spec.request,
    captures: spec.captures.map(({ id, sourcePath }) => ({ id, sourcePath })), images,
  };
  const audit = { captureCount: spec.captures.length, registeredImageEntries: entries.length, uniqueInputs: images.length, duplicatePathAliases: entries.length - images.length, aliases, excluded: spec.excluded };
  await writeJson(path.join(outputDir, "input-manifest.json"), manifest);
  await writeJson(path.join(outputDir, "input-audit.json"), audit);
  return { spec, manifest, audit };
}

/** Effective result: base rows in base order, with exactly the corrected rows replaced by ID. */
export function mergeEvidence(base: EvidenceDocument, corrections: { id: string; reason: string; document: EvidenceDocument }[]): EvidenceDocument {
  const index = new Map(base.images.map((row, i) => [row.id, i]));
  const images = base.images.map((row) => ({ ...row, analysisRun: "base" }));
  const applied = corrections.map(({ id, reason, document }) => {
    for (const row of document.images) {
      const at = index.get(row.id), original = at === undefined ? undefined : base.images[at];
      if (!original) throw new Error(`Correction ${id} has an unknown image: ${row.id}`);
      if (row.sha256 !== original.sha256 || row.captureId !== original.captureId || row.sourcePath !== original.sourcePath || row.time !== original.time)
        throw new Error(`Correction ${id} changed the source of ${row.id}`);
      if (row.status !== "resolved") throw new Error(`Correction ${id} did not resolve ${row.id}`);
      images[at!] = { ...row, analysisRun: id };
    }
    return { id, reason, fingerprint: document.fingerprint, imageIds: document.images.map((row) => row.id) };
  });
  const last = corrections.at(-1)?.document;
  return { ...base, context: last?.context ?? base.context, request: last?.request ?? base.request, images, provenance: { baseFingerprint: base.fingerprint, corrections: applied } };
}

export function runEvidenceChecks(document: EvidenceDocument, checks: EvidenceLoopSpec["checks"]) {
  const fold = (text: string) => text.normalize("NFC").toLowerCase();
  return checks.map((item) => {
    const scope = document.images.filter((row) => (!item.captureIds || item.captureIds.includes(row.captureId)) && (!item.imageIds || item.imageIds.includes(row.id)));
    const text = (row: EvidenceRow) => fold((item.fields ?? FIELDS).flatMap((field) => row.fields?.[field] ?? []).join("\n"));
    const includes = (item.includes ?? []).map(fold), excludes = (item.excludes ?? []).map(fold);
    const matched = includes.length ? scope.filter((row) => includes.every((term) => text(row).includes(term))).map((row) => row.id) : [];
    const violations = scope.filter((row) => excludes.some((term) => text(row).includes(term))).map((row) => row.id);
    return { name: item.name, pass: scope.length > 0 && (!includes.length || matched.length > 0) && !violations.length, scope: scope.length, matched, violations };
  });
}

/** Completion gate: every row resolved, table rows equal to input IDs, every linked image byte-identical. */
export async function verifyEvidence(manifest: EvidenceManifest, document: EvidenceDocument, table: string, checks: ReturnType<typeof runEvidenceChecks>) {
  const inputIds = manifest.images.map((image) => image.id), resultIds = document.images.map((row) => row.id);
  const tableIds = [...table.matchAll(/^\| (\S+) \| /gm)].map((match) => match[1].replace(/\\/g, "")).filter((id) => id !== "imageId" && id !== "---");
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
  const unresolved = document.images.filter((row) => row.status !== "resolved").map((row) => row.id);
  const brokenImages: string[] = [];
  for (const row of document.images) {
    const bytes = await readFile(row.path).catch(() => undefined);
    if (!bytes || sha256Hex(bytes) !== row.sha256) brokenImages.push(row.id);
  }
  const represented = new Set(document.images.filter((row) => row.status === "resolved").map((row) => row.captureId));
  const missingCaptures = manifest.captures.map((capture) => capture.id).filter((id) => !represented.has(id));
  const failedChecks = checks.filter((item) => !item.pass).map((item) => item.name);
  const idsMatch = same(inputIds, resultIds) && same(inputIds, tableIds);
  return {
    pass: idsMatch && !unresolved.length && !brokenImages.length && !missingCaptures.length && !failedChecks.length,
    inputIds: inputIds.length, resultIds: resultIds.length, tableRows: tableIds.length, idsMatch,
    unresolved, brokenImages, missingCaptures, checks: checks.length, failedChecks,
  };
}

async function finish(manifest: EvidenceManifest, spec: EvidenceLoopSpec, document: EvidenceDocument, outputDir: string) {
  const effective = path.join(outputDir, "effective");
  await mkdir(effective, { recursive: true, mode: 0o700 });
  const results = path.join(effective, "results.json"), tableFile = path.join(effective, "metadata-table.md");
  await writeJson(results, document);
  const table = renderEvidenceMetadataTable(document, results);
  await writeFile(tableFile, table, { mode: 0o600 });
  const checks = runEvidenceChecks(document, spec.checks);
  await writeJson(path.join(effective, "semantic-checks.json"), checks);
  const verification = await verifyEvidence(manifest, document, table, checks);
  await writeJson(path.join(effective, "verification.json"), verification);
  return { ...verification, results, table: tableFile };
}

/**
 * Rerunnable loop: assemble → analyze → corrections → merge → table → verify.
 * Successful batches are reused, so fixing the spec and rerunning touches only what changed.
 */
export async function runEvidenceLoop(specInput: unknown, outputDir: string, analyzer: ImageAnalyzer, options: { checkOnly?: boolean; onProgress?: (line: string) => void } = {}) {
  const output = path.resolve(outputDir), say = options.onProgress ?? (() => {});
  const { spec, manifest, audit } = await assembleEvidence(specInput, output);
  say(`Assembled ${audit.uniqueInputs} images from ${audit.registeredImageEntries} entries`);
  const baseDir = path.join(output, "base");
  const progress = (label: string) => ({ onProgress: ({ completedBatches, totalBatches, failedBatches }: { completedBatches: number; totalBatches: number; failedBatches: number }) => say(`${label} ${completedBatches}/${totalBatches}; failed ${failedBatches}`) });
  if (options.checkOnly) return { stage: "check", pass: true, ...await analyzeEvidence(manifest, baseDir, analyzer, { checkOnly: true }) };
  const base = await analyzeEvidence(manifest, baseDir, analyzer, progress("Base"));
  if (!base.analysisComplete) return { stage: "base", ...base, pass: false };
  const corrected = [];
  for (const correction of spec.corrections) {
    const images = manifest.images.filter((image) => correction.captureIds?.includes(image.captureId) || correction.imageIds?.includes(image.id));
    const known = new Set(manifest.images.flatMap((image) => [image.id, image.captureId]));
    const unknown = [...correction.captureIds ?? [], ...correction.imageIds ?? []].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Correction ${correction.id} names unknown IDs: ${unknown.join(", ")}`);
    const used = new Set(images.map((image) => image.captureId));
    const directory = path.join(output, "corrections", correction.id);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const coverage = await analyzeEvidence({
      ...manifest, context: correction.context ?? manifest.context, request: correction.request ?? manifest.request,
      captures: manifest.captures.filter((capture) => used.has(capture.id)), images,
    }, directory, analyzer, progress(correction.id));
    if (!coverage.analysisComplete) return { stage: `correction:${correction.id}`, ...coverage, pass: false };
    corrected.push({ id: correction.id, reason: correction.reason, document: await readJson<EvidenceDocument>(path.join(directory, "results.json")) });
  }
  const document = mergeEvidence(await readJson<EvidenceDocument>(path.join(baseDir, "results.json")), corrected);
  return { stage: "verified", ...await finish(manifest, spec, document, output) };
}

/**
 * Connects a verified result to the editor's photo picker; refuses anything that did not pass.
 * The connection is the pointer file in the project's layers folder (see blog-projects.ts),
 * not a field of a registry: a manuscript that names `editor.mediaEvidence` itself is refused.
 */
export async function connectEvidence(outputDir: string, userData: string, projectId: string) {
  const effective = path.join(path.resolve(outputDir), "effective");
  const verification = await readJson<{ pass: boolean }>(path.join(effective, "verification.json"));
  if (!verification.pass) throw new Error("Verification did not pass; not connecting");
  const project = (await readBlogProjects(userData)).find((item) => item.id === projectId);
  if (!project) throw new Error(`Unknown blog project: ${projectId}`);
  const mediaEvidence = path.join(effective, "results.json");
  if (project.config.mediaEvidence === mediaEvidence) return { changed: false, mediaEvidence };
  const pointer = path.join(project.config.layers, EVIDENCE_POINTER);
  if ((await manuscriptOverrides(project.config.canon)).own.mediaEvidence)
    throw new Error(`The manuscript sets editor.mediaEvidence; change it there: ${project.config.canon}`);
  await mkdir(project.config.layers, { recursive: true });
  await copyFile(pointer, `${pointer}.before-evidence-${Date.now()}`).catch((e) => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; });
  await writeJson(pointer, { version: 1, results: path.relative(project.config.layers, mediaEvidence).split(path.sep).join("/") });
  return { changed: true, mediaEvidence, pointer };
}
