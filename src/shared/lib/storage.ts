import {
  mkdir,
  readFile,
  writeFile,
  rename,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { emptyDashboard, type Dashboard } from "../contracts";
import { validateDashboard } from "../data";
export function safeDocumentName(name: unknown): string {
  if (
    typeof name !== "string" ||
    name.length > 120 ||
    !name.match(/^[A-Za-z0-9가-힣_-]+(?:\.json)?$/)
  )
    throw new Error("Invalid document name");
  return name.replace(/\.json$/, "");
}
export class LocalStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, "documents"), {
      recursive: true,
      mode: 0o700,
    });
  }
  async load(): Promise<Dashboard> {
    try {
      return validateDashboard(
        JSON.parse(
          await readFile(path.join(this.root, "dashboard.json"), "utf8"),
        ),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { ...emptyDashboard(), updatedAt: "1970-01-01T00:00:00.000Z" };
      throw e;
    }
  }
  async update(
    change: (current: Dashboard) => Dashboard | Promise<Dashboard>,
    expectedUpdatedAt?: string,
  ): Promise<Dashboard> {
    const operation = this.queue.then(async () => {
      const current = await this.load();
      if (
        expectedUpdatedAt !== undefined &&
        current.updatedAt !== expectedUpdatedAt
      )
        throw new Error(
          "STALE_DASHBOARD: 현황이 변경됐어요. 다시 조회하고 수정해주세요.",
        );
      const valid = validateDashboard(await change(structuredClone(current)));
      valid.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
      ).toISOString();
      await this.atomic(path.join(this.root, "dashboard.json"), valid);
      return valid;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async save(value: unknown, expectedUpdatedAt?: string) {
    await this.update(() => validateDashboard(value), expectedUpdatedAt);
  }
  async document(name: string, data: unknown): Promise<string> {
    const clean = safeDocumentName(name);
    const file = path.join(
      this.root,
      "documents",
      `${clean}-${randomUUID()}.json`,
    );
    const json = JSON.stringify(data, null, 2);
    if (json === undefined || json.length > 1024 * 1024)
      throw new Error("Invalid or oversized document");
    await writeFile(file, json + "\n", { flag: "wx", mode: 0o600 });
    return realpath(file);
  }
  async atomic(file: string, data: unknown) {
    const temp = file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, file);
  }
}
export async function resolveGrantedFile(
  file: unknown,
  grants: Set<string>,
): Promise<string> {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw new Error("File access was not granted");
  let resolved: string;
  try {
    // Parent aliases such as /var and /private/var can name the same evidence
    // file. Reject symlinks at the file itself, then check the canonical grant.
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Not a regular file");
    resolved = await realpath(file);
  } catch {
    throw new Error("File access was not granted");
  }
  const granted = [...grants].some(
    (candidate) =>
      candidate === resolved ||
      (process.platform === "darwin" &&
        candidate.normalize("NFC") === resolved.normalize("NFC")),
  );
  if (!granted) throw new Error("File access was not granted");
  return resolved;
}
