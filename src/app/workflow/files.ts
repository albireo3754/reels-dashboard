import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
export async function resolveFile(workspace: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error("Use workspace-relative paths without '..'");
  const resolved = await realpath(path.join(workspace, relative));
  if (!resolved.startsWith(workspace + path.sep))
    throw new Error("File escapes workspace");
  if (!(await stat(resolved)).isFile())
    throw new Error("Expected a file: " + relative);
  return resolved;
}
/** Parse a workspace-relative JSON file, rejecting it with `tooLarge` when over `limit` bytes. */
export async function readWorkspaceJson(
  workspace: string,
  relative: string,
  limit: number,
  tooLarge: string,
) {
  const resolved = await resolveFile(workspace, relative);
  if ((await stat(resolved)).size > limit) throw new Error(tooLarge);
  return JSON.parse(await readFile(resolved, "utf8"));
}
/** Question/preview image rule shared by form registration and step skipping. */
export async function checkedImage(workspace: string, relative: string) {
  const file = await resolveFile(workspace, relative);
  const type = (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    } as Record<string, string>
  )[path.extname(file).toLowerCase()];
  if (!type || (await stat(file)).size > 4000000)
    throw new Error("Use a JPEG/PNG/WebP preview under 4 MB");
  return { file, type };
}
export async function hashes(workspace: string, files: string[]) {
  const entries = await Promise.all(
    files.map(async (name) => {
      const file = await resolveFile(workspace, name);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      return [name, hash.digest("hex")];
    }),
  );
  return Object.fromEntries(entries) as Record<string, string>;
}
