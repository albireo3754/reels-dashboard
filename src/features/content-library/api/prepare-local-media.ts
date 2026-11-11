import { constants, createReadStream, type Stats } from "node:fs";
import { copyFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { errorMessage } from "../../../shared/lib/errors";
import { StoreUnreadable } from "../../../shared/lib/storage";
import { mediaExtensions, UnsupportedMedia, type ContentLibrary } from "./library";

export async function hash(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export async function copyVerifiedFile(source: string, output: string, before?: Stats) {
  const info = before ?? await stat(source);
  const sourceHash = await hash(source);
  await copyFile(source, output, constants.COPYFILE_EXCL);
  const after = await stat(source);
  const outputHash = await hash(output);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || outputHash !== sourceHash)
    throw new Error(`Media changed or copy verification failed: ${path.basename(source)}. Inspect the incomplete destination before retrying.`);
  return {bytes:after.size,sha256:outputHash};
}

type PrepareInput = { projectId: string; sources: string[]; destination: string };
type Library = Pick<ContentLibrary, "resolveMedia">;

/** The request was refused before the destination existed, so nothing was written. `issues` names each refused file. */
export class LocalMediaRejected extends Error {
  constructor(message: string, readonly issues: { path: string[]; message: string }[] = []) {
    super(message);
  }
}

async function checkSource(library: Library, projectId: string, file: string) {
  let source;
  try {
    source = await library.resolveMedia(projectId, file);
  } catch (error) {
    if (error instanceof StoreUnreadable) throw error;
    throw new LocalMediaRejected(error instanceof UnsupportedMedia ? `Not a supported media file (${mediaExtensions.join(" ")}).` : errorMessage(error));
  }
  if (!source.info.isFile()) throw new LocalMediaRejected("Select files, not folders. A folder resource needs the paths of the files inside it.");
  return source;
}

async function checkSelection(library: Library, input: PrepareInput) {
  if (!path.isAbsolute(input.destination) || path.resolve(input.destination) !== input.destination || input.destination.includes("\0"))
    throw new LocalMediaRejected("Choose an absolute local destination.");
  if (!input.sources.length || input.sources.length > 100 || new Set(input.sources).size !== input.sources.length)
    throw new LocalMediaRejected("Select 1–100 distinct registered media files.");
  const names = input.sources.map(file => path.basename(file));
  if (new Set(names.map(name => name.normalize("NFC").toLowerCase())).size !== names.length || names.includes("receipt.json"))
    throw new LocalMediaRejected("Selected filenames collide.");
  // Resolve every grant before making any output; no arbitrary file copy API.
  const results = await Promise.allSettled(input.sources.map(file => checkSource(library, input.projectId, file)));
  const sources = [];
  const issues = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") sources.push(result.value);
    else if (result.reason instanceof LocalMediaRejected) issues.push({ path: [input.sources[index]], message: result.reason.message });
    else throw result.reason;
  }
  if (issues.length) {
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    throw new LocalMediaRejected(`${issues[0].path[0]}: ${issues[0].message}${more}`, issues);
  }
  for (const source of sources) {
    if (input.destination === source.path || input.destination.startsWith(path.dirname(source.path) + path.sep))
      throw new LocalMediaRejected("Choose an output folder outside the source folders.");
  }
  const folder = path.dirname(input.destination);
  const parent = await realpath(folder).catch(() => {
    throw new LocalMediaRejected(`Destination parent does not exist or cannot be read: ${folder}`);
  });
  if (parent !== folder) throw new LocalMediaRejected("Destination parent must not be a symlink.");
  return sources;
}

/** Prepare registered footage for another local editor. Sources remain unchanged. */
export async function prepareLocalMedia(library: Library, input: PrepareInput) {
  const sources = await checkSelection(library, input);
  // A new directory prevents overwriting an existing export or unrelated files.
  await mkdir(input.destination, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    throw new LocalMediaRejected(error.code === "EEXIST" ? `Destination already exists: ${input.destination}` : errorMessage(error));
  });
  const entries = [];
  for (const source of sources) {
    const output = path.join(input.destination, path.basename(source.path));
    const verified = await copyVerifiedFile(source.path, output, source.info);
    entries.push({ source: source.path, path: output, ...verified });
  }
  const receipt = { schemaVersion: 1, projectId: input.projectId, createdAt: new Date().toISOString(), entries };
  const receiptPath = path.join(input.destination, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  return { receiptPath, ...receipt };
}
