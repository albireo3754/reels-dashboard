import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { link, lstat, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDataUrl } from "../../shared/lib/data-url";
import { errorMessage } from "../../shared/lib/errors";
import { CliError } from "./outcome";
import { localPath, type CliIO } from "./tool-command";

const outputExists = (target: string) =>
  new CliError("OUTPUT_EXISTS", `--out already exists: ${target}`);

/** Runs before the app call, so a bad `--out` costs no preview work. */
export async function checkOutputPath(out: string, io: CliIO) {
  const target = localPath(out, "--out", io);
  const parent = await stat(path.dirname(target)).catch(() => null);
  if (!parent?.isDirectory())
    throw new CliError(
      "USAGE",
      `--out parent folder does not exist: ${path.dirname(target)}`,
    );
  if (await lstat(target).catch(() => null)) throw outputExists(target);
  return target;
}

/**
 * `target` appears complete or not at all. `link` fails on an existing name,
 * unlike `rename`, so a file another process made in the meantime is kept.
 */
async function publish(bytes: Buffer, target: string) {
  const staged = path.join(
    path.dirname(target),
    `.reels-${randomBytes(8).toString("hex")}.tmp`,
  );
  const drop = () => {
    try {
      rmSync(staged, { force: true });
    } catch {
      // A leftover hidden file must not replace the real result.
    }
  };
  // A signal ends the process without unwinding this function.
  process.once("exit", drop);
  try {
    await writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
    await link(staged, target);
  } finally {
    process.off("exit", drop);
    drop();
  }
}

/** Writes the image and swaps its base64 field for `image: {path, mimeType, bytes}`. */
export async function saveImage(
  result: unknown,
  field: string,
  target: string,
) {
  const record = (result ?? {}) as Record<string, unknown>;
  const url = parseDataUrl(record[field]);
  if (!url || !/^[A-Za-z0-9+/]+={0,2}$/.test(url.data))
    throw new CliError(
      "RESPONSE_INVALID",
      `App response has no base64 data URL in "${field}".`,
    );
  const bytes = Buffer.from(url.data, "base64");
  try {
    await publish(bytes, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw outputExists(target);
    throw new CliError(
      "OUTPUT_WRITE_FAILED",
      `Could not write ${target}: ${errorMessage(error)}`,
    );
  }
  const { [field]: _image, ...rest } = record;
  return {
    ...rest,
    image: { path: target, mimeType: url.mimeType, bytes: bytes.length },
  };
}
