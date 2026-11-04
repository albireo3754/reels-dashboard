import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

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
