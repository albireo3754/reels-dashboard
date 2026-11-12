import path from "node:path";
import { mkdir } from "node:fs/promises";
import { emptyPlanning, planningSchema, planningUpdateSchema, type PlanningBridge } from "../planning";
import { readJsonFile, writeJsonAtomic } from "./fs";

/** Private provider snapshots, not another calendar or issue database. No credentials. */
export class PlanningStore implements PlanningBridge {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  get() {
    return readJsonFile(path.join(this.root, "planning.json"), value => planningSchema.parse(value), emptyPlanning);
  }
  update(value: unknown) {
    const input = planningUpdateSchema.parse(value);
    const operation = this.queue.then(async () => {
      const current = await this.get();
      if (current.updatedAt !== input.expectedUpdatedAt) throw new Error("STALE_PLANNING: 일정을 다시 불러와주세요.");
      for (const source of ["calendar", "linear"] as const) {
        if (input[source] && current[source] && Date.parse(input[source].syncedAt) < Date.parse(current[source].syncedAt))
          throw new Error("STALE_SOURCE: 이전 조회 결과로 덮어쓸 수 없어요.");
      }
      const { expectedUpdatedAt: _, ...changes } = input;
      const next = planningSchema.parse({ ...current, ...changes, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString() });
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(path.join(this.root, "planning.json"), next, { mode: 0o600 });
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
