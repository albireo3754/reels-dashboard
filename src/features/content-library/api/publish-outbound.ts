import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ICloudDeliveryInput,
  OutboundFile,
  ProjectOutbound,
} from "../../../shared/icloud-delivery";
import { isMissing } from "../../../shared/lib/fs";
import type { ContentLibrary } from "./library";
import { copyVerifiedFile, hash } from "./prepare-local-media";

const exists = async (p: string) => {
  try {
    return await lstat(p);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
};

/** Stage and verify all files, keep previous versions locally, then replace managed outputs. */
export async function publishOutbound(
  library: Pick<ContentLibrary, "resolveDeliverySource" | "completeOutbound">,
  input: ICloudDeliveryInput,
  outbound: ProjectOutbound,
  history: string,
  jobId: string,
) {
  const directory = outbound.directory;
  const parent = await realpath(path.dirname(directory));
  if (parent !== path.dirname(directory))
    throw new Error("OUTBOUND_PATH_CHANGED");
  if (!(await exists(directory))) await mkdir(directory, { mode: 0o700 });
  if (
    (await realpath(directory)) !== directory ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error("OUTBOUND_PATH_CHANGED");
  const managed = new Map(
    outbound.files.map((f) => [f.name.normalize("NFC").toLowerCase(), f]),
  );
  const staged: Array<{ temp: string; path: string; file: OutboundFile }> = [];
  const archives: Array<{ path: string; backup: string }> = [];
  const installed: string[] = [];
  const removed: string[] = [];
  let committed = false;
  const assertUnchanged = async () => {
    for (const f of outbound.files) {
      const file = path.join(directory, f.name),
        info = await exists(file);
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        info.size !== f.bytes ||
        (await hash(file)) !== f.sha256
      )
        throw new Error(`OUTBOUND_CHANGED: ${f.name}`);
    }
  };
  await assertUnchanged();
  for (const f of input.files) {
    const target = path.join(directory, f.name);
    const previous = managed.get(f.name.normalize("NFC").toLowerCase());
    if (previous && previous.name !== f.name)
      throw new Error("OUTBOUND_NAME: 기존 파일명 표기를 유지해주세요.");
    if ((await exists(target)) && !previous)
      throw new Error(`OUTBOUND_COLLISION: ${f.name}`);
    if (
      path.extname(f.sourcePath).toLowerCase() !==
      path.extname(f.name).toLowerCase()
    )
      throw new Error("OUTBOUND_EXTENSION: 확장자를 유지해주세요.");
    if (f.sourcePath.startsWith(directory + path.sep))
      throw new Error("OUTBOUND_SOURCE: outbound 밖의 원본을 선택해주세요.");
  }
  await mkdir(history, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(history, "receipt.json");
  try {
    for (const f of outbound.files) {
      const file = path.join(directory, f.name),
        backup = path.join(history, f.name);
      const copied = await copyVerifiedFile(file, backup);
      if (copied.sha256 !== f.sha256) throw new Error("OUTBOUND_CHANGED");
      archives.push({ path: file, backup });
    }
    for (const f of input.files) {
      const source = await library.resolveDeliverySource(
        input.projectId,
        f.sourcePath,
      );
      const target = path.join(directory, f.name),
        temp = path.join(directory, `.${jobId}-${f.name}`);
      // Track the temporary path even if copying fails part way through.
      const entry = {
        temp,
        path: target,
        file: { name: f.name, role: f.role, bytes: 0, sha256: "" },
      };
      staged.push(entry);
      Object.assign(
        entry.file,
        await copyVerifiedFile(source.path, temp, source.info),
      );
    }
    await assertUnchanged();
    for (const entry of staged) {
      if (
        !managed.has(entry.file.name.normalize("NFC").toLowerCase()) &&
        (await exists(entry.path))
      )
        throw new Error("OUTBOUND_COLLISION");
    }
    const receipt = {
      schemaVersion: 1,
      projectId: input.projectId,
      directory,
      generation: outbound.generation + 1,
      jobId,
      createdAt: new Date().toISOString(),
      sources: input.files,
      files: staged.map((s) => s.file),
      archives,
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    for (const entry of staged) {
      await rename(entry.temp, entry.path);
      installed.push(entry.path);
    }
    const next = new Set(staged.map((s) => s.path));
    for (const previous of archives)
      if (!next.has(previous.path)) {
        await unlink(previous.path);
        removed.push(previous.path);
      }
    await library.completeOutbound(
      input.projectId,
      directory,
      outbound.generation,
      receipt.files,
      receiptPath,
      archives,
    );
    committed = true;
    return {
      receiptPath,
      paths: staged.map((s) => s.path),
      files: receipt.files,
    };
  } catch (error) {
    // Restore only paths this operation changed; never touch unrelated files.
    const restore = new Map(archives.map((a) => [a.path, a.backup]));
    for (const file of [...installed, ...removed]) {
      if (restore.has(file)) {
        const temp = path.join(
          directory,
          `.${jobId}-restore-${path.basename(file)}`,
        );
        await copyFile(restore.get(file)!, temp);
        await rename(temp, file);
      } else await unlink(file);
    }
    throw error;
  } finally {
    for (const entry of staged)
      if (await exists(entry.temp)) await unlink(entry.temp);
    if (!committed)
      await writeFile(
        path.join(history, "failed.json"),
        JSON.stringify({ jobId, state: "failed", receiptPath, archives }) +
          "\n",
      );
  }
}
