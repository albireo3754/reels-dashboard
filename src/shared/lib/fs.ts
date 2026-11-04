import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

/**
 * Replace `file` without readers ever seeing a partial write: write a unique sibling
 * temp file exclusively, then rename it over the target. The temp file is removed on failure.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { flag: "wx", mode: options.mode });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Pretty-printed JSON variant of {@link writeFileAtomic}, with a trailing newline. */
export const writeJsonAtomic = (
  file: string,
  value: unknown,
  options?: { mode?: number },
) => writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", options);

/** True when a filesystem error means the path does not exist. */
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Read `file` as UTF-8 JSON and pass the parsed value to `parse`.
 * A missing file returns `fallback()`. Every other read error, the bare
 * `SyntaxError` from `JSON.parse` and any error thrown by `parse` propagate
 * unchanged.
 */
export async function readJsonFile<T>(
  file: string,
  parse: (value: unknown) => T,
  fallback: () => T,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return fallback();
    throw error;
  }
  return parse(JSON.parse(raw));
}
