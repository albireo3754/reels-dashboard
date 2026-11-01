import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  createWorkflowInput,
  submitWorkflowInput,
  workflowIdInput,
  type WorkflowRun,
  type WorkflowStage,
  type WorkflowRecord,
  type SdkJob,
  executeWorkflowInput,
} from "../../shared/workflow";

const State = Annotation.Root({ run: Annotation<WorkflowRun>() });
const instructions: Record<WorkflowStage, string> = {
  prepare:
    "작업공간 지침과 원본 근거를 읽고 확인된 사실·레퍼런스·미확인 항목을 기록하세요. 경험을 만들어내지 마세요.",
  draft:
    "준비된 근거로 로컬 초안을 작성하고 결과 파일과 변경 내용을 기록하세요.",
  review:
    "원본 근거와 작성 기준으로 현재 문안을 검토하세요. 구체적인 근거와 함께 통과·수정 필요·보류를 판단하세요. 검토 중인 입력 파일은 수정하지 마세요.",
  revise:
    "앞선 리뷰의 지적을 문안에 반영하세요. 사용자 정정을 보존하고 변경 내용을 기록하세요.",
  layout:
    "문안과 선택한 자산으로 로컬 화면을 구성하거나 수정하세요. 실제 렌더링을 확인하고 결과 파일을 기록하세요.",
  visual_review:
    "실제 미리보기를 필요한 화면 폭에서 확인하세요. 캡처와 판단 근거를 남기고 통과·수정 필요·보류를 선택하세요. 검토 중인 입력 파일은 수정하지 마세요.",
};

async function resolveFile(workspace: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error("Use workspace-relative paths without '..'");
  const resolved = await realpath(path.join(workspace, relative));
  if (!resolved.startsWith(workspace + path.sep))
    throw new Error("File escapes workspace");
  if (!(await stat(resolved)).isFile())
    throw new Error("Expected a file: " + relative);
  return resolved;
}
async function hashes(workspace: string, files: string[]) {
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

/** One headless server owns the runtime. CLI, MCP and browser are clients of that server. */
export class WorkflowRuntime {
  private saver: SqliteSaver;
  private db: DatabaseSync;
  private graph;
  private queue: Promise<unknown> = Promise.resolve();

  static async open(root: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new WorkflowRuntime(root);
  }
  private constructor(root: string) {
    this.db = new DatabaseSync(path.join(root, "runs.sqlite"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.db
        .prepare("SELECT pid FROM owner WHERE id=1")
        .get() as { pid: number } | undefined;
      if (owner) {
        let live = true;
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") live = false;
        }
        if (live)
          throw new Error(
            "Workflow data directory already has a running server",
          );
      }
      this.db
        .prepare("INSERT OR REPLACE INTO owner VALUES (1, ?)")
        .run(process.pid);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw e;
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS sdk_jobs (id TEXT PRIMARY KEY, run_id TEXT, data TEXT NOT NULL)",
    );
    for (const row of this.db.prepare("SELECT data FROM sdk_jobs").all() as {
      data: string;
    }[]) {
      const job: SdkJob = JSON.parse(row.data);
      if (job.status === "running" && job.observation) {
        for (const attempt of job.observation.attempts)
          if (attempt.status === "running") {
            attempt.status = "interrupted";
            attempt.endedAt = new Date().toISOString();
            attempt.durationMs = Math.max(
              0,
              Date.now() - Date.parse(attempt.startedAt),
            );
            attempt.failureType = "process-interrupted";
            attempt.cost = {
              status:
                attempt.auth === "codex-login" ? "not-applicable" : "unknown",
              usd: null,
              reason: "process-interrupted",
            };
          }
      }
      if (job.status === "running")
        this.saveJob({
          ...job,
          status: "interrupted",
          error:
            "Server stopped during execution; inspect saved artifacts before trying again.",
          updatedAt: new Date().toISOString(),
        });
    }
    try {
      this.saver = SqliteSaver.fromConnString(
        path.join(root, "checkpoints.sqlite"),
      );
    } catch (e) {
      this.db
        .prepare("DELETE FROM owner WHERE id=1 AND pid=?")
        .run(process.pid);
      this.db.close();
      throw e;
    }
    const work = async ({ run }: { run: WorkflowRun }) => {
      // No side effects before interrupt: a resumed node begins again here.
      const response = interrupt({
        ...run.task,
        workspace: run.workspace,
        instructions: run.instructions,
      });
      const result = submitWorkflowInput.parse(response);
      if (
        ["pass", "revise"].includes(result.outcome) &&
        JSON.stringify(await hashes(run.workspace, run.trackedFiles)) !==
          JSON.stringify(run.task!.inputHashes)
      )
        throw new Error(
          "STALE_INPUT: tracked files changed before review was recorded",
        );
      const evidence = await hashes(run.workspace, result.evidence);
      const history: WorkflowRecord[] = [
        ...run.history,
        {
          stage: run.stage,
          taskId: result.taskId,
          outcome: result.outcome,
          summary: result.summary,
          evidence,
          at: new Date().toISOString(),
        },
      ];
      let stage = run.stage,
        status: WorkflowRun["status"] = "waiting",
        revisions = run.revisions;
      if (result.outcome === "cancel") status = "cancelled";
      else if (result.outcome === "blocked") status = "blocked";
      else if (result.outcome === "revise") {
        revisions++;
        if (revisions > run.maxRevisions) status = "blocked";
        else stage = run.stage === "visual_review" ? "layout" : "revise";
      } else if (run.stage === "visual_review") status = "ready";
      else
        stage = (
          {
            prepare: "draft",
            draft: "review",
            review: "layout",
            revise: "review",
            layout: "visual_review",
          } as const
        )[run.stage];
      const textApproval =
        run.stage === "review" && result.outcome === "pass"
          ? Object.fromEntries(
              Object.entries(run.task!.inputHashes).filter(
                ([file]) => !run.layoutFiles.includes(file),
              ),
            )
          : run.textApproval;
      if (
        (run.stage === "layout" && result.outcome === "done") ||
        (run.stage === "visual_review" && result.outcome === "pass")
      ) {
        if (
          JSON.stringify(
            await hashes(run.workspace, Object.keys(textApproval)),
          ) !== JSON.stringify(textApproval)
        ) {
          stage = "review";
          status = "waiting";
        }
      }
      const trackedFiles =
        result.outcome === "done"
          ? [...new Set([...run.trackedFiles, ...result.evidence])]
          : run.trackedFiles;
      return {
        run: {
          ...run,
          stage,
          status,
          revisions,
          history,
          trackedFiles,
          textApproval,
          layoutFiles:
            run.stage === "layout" && result.outcome === "done"
              ? [
                  ...new Set([
                    ...run.layoutFiles,
                    ...result.evidence.filter(
                      (file) => !(file in textApproval),
                    ),
                  ]),
                ]
              : run.layoutFiles,
          task: null,
          sequence: run.sequence + 1,
        },
      };
    };
    const next = ({ run }: { run: WorkflowRun }) =>
      run.status === "waiting" ? ("request" as const) : END;
    this.graph = new StateGraph(State)
      .addNode("request", async ({ run }) => ({
        run: {
          ...run,
          status: "waiting" as const,
          task: {
            taskId: `${run.runId}:${run.sequence}`,
            stage: run.stage,
            instruction: instructions[run.stage],
            inputHashes: await hashes(run.workspace, run.trackedFiles),
          },
        },
      }))
      .addNode("prepare", work)
      .addNode("draft", work)
      .addNode("review", work)
      .addNode("revise", work)
      .addNode("layout", work)
      .addNode("visual_review", work)
      .addEdge(START, "request")
      .addConditionalEdges("request", ({ run }) => run.stage, [
        "prepare",
        "draft",
        "review",
        "revise",
        "layout",
        "visual_review",
      ])
      .addConditionalEdges("prepare", next, ["request", END])
      .addConditionalEdges("draft", next, ["request", END])
      .addConditionalEdges("review", next, ["request", END])
      .addConditionalEdges("revise", next, ["request", END])
      .addConditionalEdges("layout", next, ["request", END])
      .addConditionalEdges("visual_review", next, ["request", END])
      .compile({ checkpointer: this.saver });
  }
  private config(id: string) {
    return { configurable: { thread_id: id } };
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async get(raw: unknown): Promise<WorkflowRun> {
    const { runId } = workflowIdInput.parse(raw);
    const snapshot = await this.graph.getState(this.config(runId));
    if (!snapshot.values.run) throw new Error("Unknown workflow run");
    return {
      ...snapshot.values.run,
      checkpoint: snapshot.config.configurable?.checkpoint_id ?? "",
      execution: this.latestJob(runId),
    };
  }
  async list() {
    const rows = this.db
      .prepare("SELECT id FROM runs ORDER BY rowid DESC")
      .all() as { id: string }[];
    return Promise.all(rows.map(({ id }) => this.get({ runId: id })));
  }
  async create(raw: unknown) {
    return this.serialize(async () => {
      const input = createWorkflowInput.parse(raw);
      const workspace = await realpath(input.workspace);
      if (!(await stat(workspace)).isDirectory())
        throw new Error("Workspace must be a directory");
      await hashes(workspace, input.trackedFiles);
      const runId = randomUUID();
      const run: WorkflowRun = {
        ...input,
        workspace,
        runId,
        revisions: 0,
        sequence: 0,
        stage: "prepare",
        status: "waiting",
        history: [],
        textApproval: {},
        layoutFiles: [],
        task: null,
        checkpoint: "",
      };
      await this.graph.invoke({ run }, this.config(runId));
      this.db.prepare("INSERT INTO runs VALUES (?)").run(runId);
      return this.get({ runId });
    });
  }
  async submit(raw: unknown, executorJobId?: string) {
    return this.serialize(async () => {
      const input = submitWorkflowInput.parse(raw);
      const run = await this.get({ runId: input.runId });
      this.assertNotExecuting(run.runId, executorJobId);
      if (run.status !== "waiting" || run.task?.taskId !== input.taskId)
        throw new Error("STALE_TASK: refresh the run before submitting");
      const review = run.stage === "review" || run.stage === "visual_review";
      if (!["cancel", "blocked"].includes(input.outcome)) {
        if (
          review
            ? !["pass", "revise"].includes(input.outcome)
            : input.outcome !== "done"
        )
          throw new Error("Invalid outcome for this stage");
        if (!input.evidence.length)
          throw new Error("Evidence files are required");
        if (
          review &&
          JSON.stringify(await hashes(run.workspace, run.trackedFiles)) !==
            JSON.stringify(run.task.inputHashes)
        )
          throw new Error(
            "STALE_INPUT: tracked files changed; refresh the review before submitting",
          );
      }
      await hashes(run.workspace, input.evidence);
      await this.graph.invoke(
        new Command({ resume: input }),
        this.config(run.runId),
      );
      return this.get({ runId: run.runId });
    });
  }
  /** Invalidate the pending task, or reopen a held run, without treating old evidence as a pass. */
  async restart(raw: unknown) {
    return this.serialize(async () => {
      const { runId } = workflowIdInput.parse(raw);
      this.assertNotExecuting(runId);
      const run = await this.get({ runId });
      if (run.status === "cancelled")
        throw new Error("Cancelled runs cannot resume");
      const stage = run.status === "ready" ? "review" : run.stage;
      const next = {
        ...run,
        stage,
        status: "waiting" as const,
        task: null,
        sequence: run.sequence + 1,
      };
      // Set the predecessor state so execution continues at request, never at an old interrupt.
      await this.graph.updateState(
        this.config(runId),
        { run: next },
        run.stage,
      );
      await this.graph.invoke(null, this.config(runId));
      return this.get({ runId });
    });
  }
  async close() {
    await this.queue;
    this.saver.db.close();
    this.db.prepare("DELETE FROM owner WHERE id=1 AND pid=?").run(process.pid);
    this.db.close();
  }
  private assertNotExecuting(runId: string, executorJobId?: string) {
    const job = this.latestJob(runId);
    if (job?.status === "running" && job.id !== executorJobId)
      throw new Error("SDK_BUSY: stop or finish the SDK job first");
  }
  latestJob(runId: string): SdkJob | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM sdk_jobs WHERE run_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(runId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  getJob(id: string): SdkJob {
    const row = this.db
      .prepare("SELECT data FROM sdk_jobs WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Error("Unknown SDK job");
    return JSON.parse(row.data);
  }
  saveJob(job: SdkJob) {
    this.db
      .prepare(
        "INSERT INTO sdk_jobs(id,run_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, job.runId ?? null, JSON.stringify(job));
  }
  async claimExecution(raw: unknown, job: SdkJob) {
    return this.serialize(async () => {
      const input = executeWorkflowInput.parse(raw);
      this.assertNotExecuting(input.runId);
      const run = await this.get({ runId: input.runId });
      if (run.status !== "waiting" || run.task?.taskId !== input.taskId)
        throw new Error("STALE_TASK: refresh before executing");
      if (
        JSON.stringify(await hashes(run.workspace, run.trackedFiles)) !==
        JSON.stringify(run.task.inputHashes)
      )
        throw new Error("STALE_INPUT: refresh the task before executing");
      this.saveJob(job);
      return run;
    });
  }
}
