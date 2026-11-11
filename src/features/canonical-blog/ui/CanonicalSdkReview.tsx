import { errorMessage } from "../../../shared/lib/errors";
import { useEffect, useRef, useState } from "react";
import {
  readInline,
  type CanonicalDocument,
  type CanonicalFinding,
} from "../../../shared/canonical-blog";
import {
  bundlesOf,
  validateResult,
  type ReviewRequest,
  type ReviewResult,
} from "../../../shared/blog-bundle-review";
import { workflowCall } from "../../../shared/workflow-client";
import { SdkProgress } from "../../../shared/ui/SdkProgress";
import type { SdkJob } from "../../../shared/workflow";

export function CanonicalSdkReview({
  document,
  selected,
  dirty,
  busy,
  onApply,
}: {
  document: CanonicalDocument;
  selected: string;
  dirty: boolean;
  busy: boolean;
  onApply: (finding: CanonicalFinding) => void;
}) {
  const [job, setJob] = useState<SdkJob>();
  const [pending, setPending] = useState<{
    request: ReviewRequest;
    revision: string;
  }>();
  const [result, setResult] = useState<ReviewResult>();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [criteria, setCriteria] = useState("");
  const current = useRef({ document, dirty });
  current.current = { document, dirty };
  const stale = !!pending && (pending.revision !== document.revision || dirty);
  const running = starting || job?.status === "running";
  async function start() {
    setError("");
    setStarting(true);
    setResult(undefined);
    try {
      const blocks = document.paragraphs.map((p) => ({
        id: p.id,
        type: "text" as const,
        text: readInline(p.source)
          .map((run) => run.text)
          .join(""),
      }));
      const groups = document.bundles
        .filter((bundle) => bundle.paragraphIds.length)
        .map((bundle) => ({
          id: bundle.id,
          name: bundle.name,
          question: bundle.question,
          startBlockId: bundle.paragraphIds[0],
        }));
      if (!groups.some((g) => g.id === selected))
        throw new Error(
          "텍스트가 없는 묶음은 문안 검토 대신 화면 검토가 필요해요.",
        );
      const draft = {
        projectId: "canonical-blog",
        revision: 0,
        blocks,
        reviewGroups: groups,
      };
      const request: ReviewRequest = {
        schemaVersion: 1,
        kind: "blog.bundle-review.request",
        requestId: crypto.randomUUID(),
        projectId: draft.projectId,
        scope: "selected",
        bundleIds: [selected],
        draft,
        bundles: bundlesOf(draft),
      };
      setPending({ request, revision: document.revision });
      setJob(
        await workflowCall("review-bundles", {
          request,
          ...(criteria.trim() ? { criteria } : {}),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }
  useEffect(() => {
    if (!job || job.status !== "running" || !pending) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next: SdkJob = await workflowCall("job", { jobId: job.id });
        if (!live) return;
        setJob(next);
        if (next.status === "completed") {
          try {
            if (
              current.current.document.revision !== pending.revision ||
              current.current.dirty
            )
              throw new Error(
                "검토 중 원고가 바뀌었어요. 저장 후 다시 검토해주세요.",
              );
            setResult(validateResult(next.result, pending.request));
          } catch (e) {
            setError(errorMessage(e));
          }
        } else if (next.status === "running") timer = setTimeout(poll, 1000);
      } catch (e) {
        if (live) {
          setError(errorMessage(e));
          timer = setTimeout(poll, 3000);
        }
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [job?.id, pending?.request.requestId]);
  const review = result?.reviews.find((review) => review.bundleId === selected);
  return (
    <section className="ce-sdk-review" aria-label="정본 Codex 문안 검토">
      <h3>Codex 문안 검토</h3>
      <p className="ui-meta">저장된 문장으로 검토해요. 제안은 자동으로 적용하지 않아요.</p>
      <details>
        <summary>검토 기준·추가 근거</summary>
        <textarea
          aria-label="정본 Codex 검토 기준"
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          maxLength={20000}
        />
      </details>
      <button
        className="secondary small"
        disabled={busy || dirty || running || !selected}
        onClick={() => void start()}
      >
        Codex로 선택 묶음 검토
      </button>
      {dirty && <p className="ui-meta">현재 편집을 정본에 저장한 뒤 검토할 수 있어요.</p>}
      <SdkProgress
        job={job}
        onStop={(jobId) => {
          void workflowCall("stop", { jobId })
            .then(setJob)
            .catch((e) => setError(e.message));
        }}
      />
      {error && <p role="alert">{error}</p>}
      {stale && result && <p>이후 원고가 바뀌어 제안 적용을 잠갔어요.</p>}
      {review && (
        <>
          <p>{review.summary}</p>
          {review.findings.map((f) => (
            <article className="ce-proposal" key={f.id}>
              <p>{f.reason}</p>
              {f.before.type === "text" && f.after.type === "text" && (
                <>
                  <del>{f.before.text}</del>
                  <ins>{f.after.text}</ins>
                  <button
                    className="small"
                    disabled={busy || stale}
                    onClick={() =>
                      onApply({
                        id: f.id,
                        observation: f.reason,
                        proposal: {
                          layer: "text",
                          tid: f.blockId,
                          before: f.before.type === "text" ? f.before.text : "",
                          after: f.after.type === "text" ? f.after.text : "",
                        },
                      })
                    }
                  >
                    SDK 제안 적용
                  </button>
                </>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
