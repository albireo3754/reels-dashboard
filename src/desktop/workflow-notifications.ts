import type { SdkJob, WorkflowRun } from "../shared/workflow";

type RunSnapshot = Pick<WorkflowRun, "runId" | "title" | "execution">;
export type WorkflowNotice = {
  runId: string;
  jobId: string;
  title: string;
  status: "completed" | "failed" | "interrupted";
};
const terminal = (
  status: SdkJob["status"],
): status is WorkflowNotice["status"] =>
  status === "completed" || status === "failed" || status === "interrupted";

/** A successful initial snapshot is the baseline, never a backlog of notifications. */
export class WorkflowTransitions {
  private baselineAt: number | undefined;
  private seen = new Map<string, SdkJob["status"]>();

  update(runs: RunSnapshot[], now = Date.now()): WorkflowNotice[] {
    const notices: WorkflowNotice[] = [];
    for (const run of runs) {
      const job = run.execution;
      if (!job || (job.runId && job.runId !== run.runId)) continue;
      const key = `${run.runId}:${job.taskId ?? ""}:${job.id}`;
      const before = this.seen.get(key);
      // A stale server snapshot must not reopen a terminal job's notification lifecycle.
      if (before && before !== "running") continue;
      this.seen.set(key, job.status);
      if (
        this.baselineAt !== undefined &&
        terminal(job.status) &&
        (before === "running" ||
          (before === undefined &&
            Date.parse(job.createdAt) >= this.baselineAt))
      ) {
        notices.push({
          runId: run.runId,
          jobId: job.id,
          title: run.title,
          status: job.status,
        });
      }
    }
    this.baselineAt ??= now;
    return notices;
  }
}

export interface WorkflowNotificationHost {
  enabled: boolean;
  list: () => Promise<{ runs: RunSnapshot[] }>;
  isActive: () => boolean;
  notify: (notice: WorkflowNotice, count: number, onClick: () => void) => void;
  setBadge: (count: number) => void;
  open: (runId: string) => void;
}

/** Poll the existing workflow service; this creates no SDK job or renderer transport. */
export class WorkflowNotifications {
  private transitions = new WorkflowTransitions();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private disposed = false;
  private unread = 0;
  constructor(private host: WorkflowNotificationHost) {}

  start() {
    if (!this.host.enabled || this.disposed || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 3000);
    this.timer.unref();
  }

  async poll() {
    if (!this.host.enabled || this.disposed || this.polling) return;
    this.polling = true;
    try {
      const { runs } = await this.host.list();
      if (this.disposed) return;
      const notices = this.transitions.update(runs);
      if (this.host.isActive()) {
        this.clearUnread();
        return;
      }
      if (!notices.length) return;
      this.unread += notices.length;
      this.host.setBadge(this.unread);
      const latest = notices[notices.length - 1];
      this.host.notify(latest, notices.length, () => {
        if (this.disposed) return;
        this.clearUnread();
        this.host.open(latest.runId);
      });
    } catch {
      // A stopped/offline workflow server is normal. Preserve the last good baseline.
    } finally {
      this.polling = false;
    }
  }

  clearUnread() {
    if (!this.host.enabled || !this.unread) return;
    this.unread = 0;
    this.host.setBadge(0);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.clearUnread();
  }
}
