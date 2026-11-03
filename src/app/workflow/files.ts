import { realpath, stat } from "node:fs/promises";
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
