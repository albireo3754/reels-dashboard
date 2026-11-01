import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionLog, ExecutionStart } from "../execution-log";

export function redactLog(text: string) {
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[=:]\s*["']?)[^\s&,"']+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

/** Single app-owned store. Only explicitly registered executions enter this ledger. */
export class ExecutionLogs {
  private records = new Map<string, ExecutionLog>();
  private directory: string;
  constructor(root: string) {
    this.directory = path.join(root, "execution-logs");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.directory).filter((n) =>
      /^[a-f0-9-]{36}\.json$/.test(n),
    )) {
      const record: ExecutionLog = JSON.parse(
        readFileSync(path.join(this.directory, name), "utf8"),
      );
      if (record.id + ".json" !== name)
        throw new Error("Invalid execution log ID");
      this.records.set(record.id, record);
      if (record.status === "running")
        this.finish(
          record.id,
          "interrupted",
          "앱 재시작으로 관측이 끊겼어요. 프로세스 종료 여부는 확인되지 않았어요.",
        );
    }
    this.prune();
  }
  private persist(record: ExecutionLog, strict = false) {
    const file = path.join(this.directory, record.id + ".json");
    const temporary = file + ".tmp";
    try {
      delete record.persistenceError;
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      record.persistenceError =
        "로그 파일 저장에 실패했어요. 현재 앱에서만 보이는 기록일 수 있어요.";
      if (strict) throw error;
    }
  }
  private prune() {
    const completed = [...this.records.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const record of completed.slice(200)) {
      try {
        unlinkSync(path.join(this.directory, record.id + ".json"));
        this.records.delete(record.id);
      } catch {
        /* Keep the record available when pruning fails. */
      }
    }
  }
  start(input: ExecutionStart) {
    const at = new Date().toISOString();
    const record: ExecutionLog = {
      ...input,
      id: randomUUID(),
      status: "running",
      startedAt: at,
      updatedAt: at,
      output: "",
      events: [{ at, message: "실행 시작" }],
    };
    this.persist(record, true);
    this.records.set(record.id, record);
    return record.id;
  }
  update(
    id: string,
    patch: Partial<
      Pick<ExecutionLog, "pid" | "progress" | "output" | "exitCode" | "signal">
    >,
    message?: string,
  ) {
    const record = this.records.get(id);
    if (!record || record.status !== "running") return;
    const at = new Date().toISOString();
    Object.assign(record, patch, { updatedAt: at });
    if (patch.output !== undefined)
      record.output = redactLog(patch.output).slice(-16000);
    if (message)
      record.events = [
        ...record.events,
        { at, message: redactLog(message).slice(0, 1000) },
      ].slice(-100);
    this.persist(record);
  }
  finish(
    id: string,
    status: Exclude<ExecutionLog["status"], "running">,
    message: string,
  ) {
    const record = this.records.get(id);
    if (!record || record.status !== "running") return;
    this.update(id, {}, message);
    record.status = status;
    record.endedAt = record.updatedAt;
    this.persist(record);
    this.prune();
  }
  list(): ExecutionLog[] {
    return structuredClone(
      [...this.records.values()].sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          b.startedAt.localeCompare(a.startedAt),
      ),
    );
  }
}
