import { EventEmitter } from "node:events";
import { waitFormInput } from "../../shared/input-forms";
import { formResultsSchema, formArtifactInput } from "../../shared/input-forms";
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  experienceFormSchema,
  type ExperienceRecord,
  type ExperienceForm,
} from "../../shared/experience";
import {
  createFormInput,
  saveFormInput,
  formMediaInput,
  applyFormInput,
  listFormsInput,
  type InputFormRecord,
} from "../../shared/input-forms";
import { resolveFile, hashes } from "./files";

/** One form and answer store. No graph stages, model execution or UI assumptions. The owner serializes writes. */
export class InputFormService {
  private changes = new EventEmitter();
  private waiting = new Set<() => void>();
  private closed = false;
  constructor(private db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS experience_records (run_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  private raw(id: string): ExperienceRecord | InputFormRecord | undefined {
    const row = this.db
      .prepare("SELECT data FROM experience_records WHERE run_id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  put(r: InputFormRecord) {
    this.db
      .prepare(
        "INSERT INTO experience_records(run_id,data) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data",
      )
      .run(r.formId, JSON.stringify(r));
    this.changes.emit("change", r);
  }
  async wait(
    raw: unknown,
  ): Promise<{
    reason: "change" | "timeout" | "closed";
    form: InputFormRecord;
  }> {
    const input = waitFormInput.parse(raw);
    const current = this.get(input.formId);
    if (this.closed) return { reason: "closed", form: current };
    if (current.revision > input.afterRevision)
      return { reason: "change", form: current };
    return new Promise((resolve) => {
      const finish = (
        reason: "change" | "timeout" | "closed",
        form: InputFormRecord,
      ) => {
        clearTimeout(timer);
        this.changes.off("change", listener);
        this.waiting.delete(cancel);
        resolve({ reason, form });
      };
      const listener = (form: InputFormRecord) => {
        if (form.formId === input.formId && form.revision > input.afterRevision)
          finish("change", form);
      };
      const cancel = () => finish("closed", this.get(input.formId));
      const timer = setTimeout(
        () => finish("timeout", this.get(input.formId)),
        input.timeoutMs,
      );
      this.waiting.add(cancel);
      this.changes.on("change", listener);
    });
  }
  closeWaits() {
    this.closed = true;
    for (const cancel of [...this.waiting]) cancel();
  }
  get(id: string): InputFormRecord {
    const r = this.raw(id);
    if (!r || !("formId" in r)) throw new Error("Unknown input form");
    return r;
  }
  forWorkflow(runId: string, workspace: string): InputFormRecord | undefined {
    const old = this.raw(runId);
    // Existing workflow answers keep their ID, revision, bytes and export paths. Only common metadata is added.
    if (old && !("formId" in old)) {
      const adopted: InputFormRecord = {
        ...old,
        schemaVersion: 1,
        formId: runId,
        workspace,
        projectId: "",
        workflowRunId: runId,
        registeredAt: new Date().toISOString(),
        submissionRevision:
          old.status === "submitted" ? old.revision : undefined,
        applications: [],
      };
      this.put(adopted);
      return adopted;
    }
    return this.list({}).find((r) => r.workflowRunId === runId);
  }
  list(raw: unknown) {
    const input = listFormsInput.parse(raw);
    return (
      this.db
        .prepare("SELECT data FROM experience_records ORDER BY rowid DESC")
        .all() as { data: string }[]
    )
      .map((x) => JSON.parse(x.data) as InputFormRecord)
      .filter(
        (r) =>
          r.formId &&
          (input.projectId === undefined || r.projectId === input.projectId),
      );
  }
  bind(id: string, runId: string) {
    const r = this.get(id);
    if (r.workflowRunId && r.workflowRunId !== runId)
      throw new Error("FORM_BOUND: already linked to a workflow");
    this.put({ ...r, workflowRunId: runId });
  }
  async checkedImage(workspace: string, relative: string) {
    const file = await resolveFile(workspace, relative);
    const type = (
      {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
      } as Record<string, string>
    )[path.extname(file).toLowerCase()];
    if (!type || (await stat(file)).size > 4000000)
      throw new Error("Use a JPEG/PNG/WebP preview under 4 MB");
    return { file, type };
  }
  async create(raw: unknown) {
    const input = createFormInput.parse(raw);
    const workspace = await realpath(input.workspace);
    if (!(await stat(workspace)).isDirectory())
      throw new Error("Workspace must be a directory");
    const creationHash = createHash("sha256")
      .update(JSON.stringify({ ...input, formId: undefined, workspace }))
      .digest("hex");
    if (input.formId && this.raw(input.formId)) {
      const r = this.get(input.formId);
      if (r.creationHash !== creationHash)
        throw new Error("FORM_ID_CONFLICT: existing form differs");
      return r;
    }
    const formId = input.formId ?? randomUUID();
    const sourceHashes = await this.sources(
      workspace,
      input.form,
      input.sourceFiles,
    );
    const r: InputFormRecord = {
      schemaVersion: 1,
      formId,
      workspace,
      projectId: input.projectId,
      creationHash,
      registeredAt: new Date().toISOString(),
      form: input.form,
      revision: 0,
      answers: [],
      status: "draft",
      exports: [],
      sourceHashes,
      updatedAt: new Date().toISOString(),
      applications: [],
    };
    this.put(r);
    return r;
  }
  async sources(workspace: string, form: ExperienceForm, files: string[]) {
    const images = form.questions.flatMap((q) => q.images.map((i) => i.path));
    for (const image of images) await this.checkedImage(workspace, image);
    return hashes(workspace, [...new Set([...files, ...images])]);
  }
  async registerWorkflow(
    runId: string,
    workspace: string,
    form: ExperienceForm,
    files: string[],
  ) {
    if (this.raw(runId))
      throw new Error(
        "FORM_EXISTS: use a new run rather than overwrite existing answers",
      );
    const r = await this.create({
      formId: runId,
      workspace,
      form,
      sourceFiles: files,
    });
    this.bind(r.formId, runId);
    return this.get(r.formId);
  }
  async save(raw: unknown) {
    const input = saveFormInput.parse(raw);
    const r = this.get(input.formId);
    if (r.revision !== input.expectedRevision || r.status !== "draft")
      throw new Error(
        "STALE_FORM: 다른 창에서 저장되었거나 이미 제출된 폼이에요. 입력을 복사한 뒤 다시 확인해주세요.",
      );
    const ids = input.answers.map((a) => a.questionId);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !r.form.questions.some((q) => q.id === id))
    )
      throw new Error("Unknown or duplicate question ID");
    if (input.submit) {
      for (const q of r.form.questions) {
        const a = input.answers.find((a) => a.questionId === q.id);
        if (q.required && !a)
          throw new Error(
            "답변하거나 기억나지 않음·본문 제외를 선택해주세요: " + q.prompt,
          );
        if (a?.status === "answered" && !a.text.trim())
          throw new Error("빈 답변: " + q.prompt);
      }
      const current = await hashes(r.workspace, Object.keys(r.sourceHashes));
      if (JSON.stringify(current) !== JSON.stringify(r.sourceHashes))
        throw new Error(
          "STALE_INPUT: 질문 근거가 변경됐어요. 임시저장 답변은 보존됩니다.",
        );
    }
    const next: InputFormRecord = {
      ...r,
      answers: input.answers,
      revision: r.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (input.submit) {
      next.status = "submitted";
      next.submissionRevision = next.revision;
      const base = `experience-answers-${r.formId}-${randomUUID()}`;
      next.exports = [base + ".json", base + ".md"];
      const markdown =
        "# 직접 경험 답변\n\n사용자 입력 원문. 미확인·제외 답변을 경험으로 보충하지 않는다.\n\n" +
        r.form.questions
          .map((q) => {
            const a = input.answers.find((a) => a.questionId === q.id);
            return `## ${q.prompt}\n\n상태: ${a?.status ?? "unanswered"}\n\n${a?.text ?? ""}\n`;
          })
          .join("\n");
      await writeFile(
        path.join(r.workspace, next.exports[0]),
        JSON.stringify({ version: 1, ...next }, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(path.join(r.workspace, next.exports[1]), markdown, {
        flag: "wx",
        mode: 0o600,
      });
    }
    this.put(next);
    return next;
  }
  async media(raw: unknown) {
    const input = formMediaInput.parse(raw);
    const r = this.get(input.formId);
    const image = r.form.questions.find((q) => q.id === input.questionId)
      ?.images[input.imageIndex];
    if (!image) throw new Error("Unknown question image");
    const current = await hashes(r.workspace, [image.path]);
    if (current[image.path] !== r.sourceHashes[image.path])
      throw new Error("STALE_INPUT: 질문 사진이 변경됐어요.");
    const { file, type } = await this.checkedImage(r.workspace, image.path);
    return {
      dataUrl: `data:${type};base64,${(await readFile(file)).toString("base64")}`,
    };
  }
  results(id: string) {
    const r = this.get(id);
    return formResultsSchema.parse({
      schemaVersion: 1,
      formId: r.formId,
      revision: r.revision,
      submissionRevision: r.submissionRevision,
      status: r.status,
      projectId: r.projectId,
      workflowRunId: r.workflowRunId,
      workspace: r.workspace,
      title: r.form.title,
      sourceFacts: r.form.facts,
      sourceHashes: r.sourceHashes,
      responses: r.form.questions.map((q) => {
        const a = r.answers.find((a) => a.questionId === q.id);
        return {
          questionId: q.id,
          section: q.section,
          prompt: q.prompt,
          status: a?.status ?? "unanswered",
          text: a?.text ?? "",
          images: q.images,
        };
      }),
      exports: r.exports,
      applications: r.applications,
    });
  }
  async artifact(raw: unknown) {
    const input = formArtifactInput.parse(raw),
      r = this.get(input.formId);
    const expected = r.applications
      .flatMap((a) => Object.entries(a.evidence))
      .filter(([file]) => file === input.path)
      .at(-1)?.[1];
    if (!expected && !r.exports.includes(input.path))
      throw new Error("Unregistered form artifact");
    const file = await resolveFile(r.workspace, input.path);
    if (
      ![".md", ".txt", ".json"].includes(path.extname(file).toLowerCase()) ||
      (await stat(file)).size > 2000000
    )
      throw new Error("Only text results up to 2 MB can be previewed");
    const digest = (await hashes(r.workspace, [input.path]))[input.path];
    if (expected && expected !== digest)
      throw new Error("STALE_ARTIFACT: result changed after it was recorded");
    return {
      formId: r.formId,
      path: input.path,
      sha256: digest,
      text: await readFile(file, "utf8"),
    };
  }
  async apply(raw: unknown) {
    const input = applyFormInput.parse(raw);
    const r = this.get(input.formId);
    if (r.revision !== input.expectedRevision)
      throw new Error("STALE_FORM: refresh before recording application");
    if (r.status !== "submitted")
      throw new Error("Submit answers before applying results");
    const evidence = await hashes(r.workspace, input.evidence);
    const next = {
      ...r,
      revision: r.revision + 1,
      updatedAt: new Date().toISOString(),
      applications: [
        ...r.applications,
        {
          at: new Date().toISOString(),
          submissionRevision: r.submissionRevision!,
          summary: input.summary,
          evidence,
        },
      ],
    };
    this.put(next);
    return next;
  }
}
