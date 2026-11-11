import { constants, createReadStream, type Stats } from "node:fs";
import { copyFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ContentLibrary } from "./library";

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

/** Prepare registered footage for another local editor. Sources remain unchanged. */
export async function prepareLocalMedia(
  library: Pick<ContentLibrary, "resolveMedia">,
  input: { projectId: string; sources: string[]; destination: string },
) {
  if (!path.isAbsolute(input.destination) || path.resolve(input.destination) !== input.destination || input.destination.includes("\0"))
    throw new Error("Choose an absolute local destination.");
  if (!input.sources.length || input.sources.length > 100 || new Set(input.sources).size !== input.sources.length)
    throw new Error("Select 1–100 distinct registered media files.");
  const names = input.sources.map(file => path.basename(file));
  if (new Set(names.map(name => name.normalize("NFC").toLowerCase())).size !== names.length || names.includes("receipt.json"))
    throw new Error("Selected filenames collide.");
  // Resolve every grant before making any output; no arbitrary file copy API.
  const sources = await Promise.all(input.sources.map(file => library.resolveMedia(input.projectId, file)));
  for (const source of sources) {
    if (!source.info.isFile() || input.destination === source.path || input.destination.startsWith(path.dirname(source.path) + path.sep))
      throw new Error("Choose an output folder outside the source folders.");
  }
  const parent = await realpath(path.dirname(input.destination));
  if (parent !== path.dirname(input.destination)) throw new Error("Destination parent must not be a symlink.");
  // A new directory prevents overwriting an existing export or unrelated files.
  await mkdir(input.destination, { mode: 0o700 });
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
