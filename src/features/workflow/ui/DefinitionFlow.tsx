import { useState } from "react";
import type { WorkflowRun } from "../../../shared/workflow";
import { definitionEdges } from "../../../shared/workflow-definition";
import { guideStepFor } from "../../../shared/workflow-guide";

const outcomeNames: Record<string, string> = {
  done: "완료",
  pass: "통과",
  revise: "수정",
};
/** Definition topology and checkpoint state are rendered together, without a second flow model. */
export function DefinitionFlow({ run }: { run: WorkflowRun }) {
  const [selected, setSelected] = useState("");
  const [copied, setCopied] = useState("");
  const snapshot = run.definition!;
  const { definition } = snapshot;
  const steps = definition.steps;
  const edges = definitionEdges(definition);
  const detail =
    steps.find((s) => s.id === selected) ??
    steps.find((s) => s.id === run.stepId)!;
  const localGuide = guideStepFor(run.guide, detail.id);
  const positions = new Map([
    ...steps.map((s, i) => [s.id, i] as const),
    ["$complete", steps.length],
  ]);
  const width = Math.max(560, 360 + edges.length * 12);
  const state = (id: string) => {
    if (id === run.stepId && run.status !== "ready")
      return run.status === "blocked"
        ? "보류"
        : run.status === "cancelled"
          ? "취소"
          : "현재";
    const records = run.history.filter((h) => h.stepId === id);
    return records.some((h) => ["done", "pass"].includes(h.outcome))
      ? "완료 이력"
      : records.some((h) => h.outcome === "skipped")
        ? "건너뜀 · 기존 산출물"
        : "대기";
  };
  const handoff = JSON.stringify(
    {
      runId: run.runId,
      projectId: run.projectId,
      workspace: run.workspace,
      definitionSha256: snapshot.sha256,
      instruction:
        "Call reels_workflow_context with this runId and use its current taskId. Do not restart to attach. Execute the task's skills/tools within the user's authorization, then submit evidence.",
      mcp: { name: "reels_workflow_context", arguments: { runId: run.runId } },
      cli: `npm run workflow -- context ${run.runId}`,
    },
    null,
    2,
  );
  return (
    <section className="definition-flow" aria-label="YAML 워크플로 흐름">
      <header>
        <strong>{definition.title}</strong>
        <span>
          정의 v{definition.version} · {snapshot.sha256.slice(0, 12)}
        </span>
      </header>
      <div className="definition-graph-scroll">
        <svg
          viewBox={`0 0 ${width} ${(steps.length + 1) * 88 + 20}`}
          role="img"
          aria-label="정의의 단계와 전이 · 단계 선택으로 상세 보기"
        >
          <defs>
            <marker
              id={`arrow-${run.runId}`}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 Z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((edge, i) => {
            const from =
              positions.get(edge.from)! * 88 +
              (edge.outcome === "revise" ? 58 : 32);
            const to = positions.get(edge.to)! * 88 + 42;
            const lane = 350 + i * 12;
            return (
              <g
                key={`${edge.from}-${edge.outcome}`}
                className={edge.outcome === "revise" ? "definition-revise" : ""}
              >
                <path
                  d={`M310 ${from} H${lane} V${to} H310`}
                  fill="none"
                  stroke="currentColor"
                  markerEnd={`url(#arrow-${run.runId})`}
                />
                <text
                  x="315"
                  y={from - 5}
                  fontSize="10"
                  fill="currentColor"
                  stroke="none"
                >
                  {outcomeNames[edge.outcome]}
                </text>
                <title>
                  {edge.from} → {edge.to} · {outcomeNames[edge.outcome]}
                </title>
              </g>
            );
          })}
          {[
            ...steps.map((s) => ({ id: s.id, title: s.title })),
            { id: "$complete", title: "완료" },
          ].map((step, i) => {
            const status =
              step.id === "$complete"
                ? run.status === "ready"
                  ? "완료"
                  : "대기"
                : state(step.id);
            const label = `${step.title} · ${status}`;
            return (
              <g
                key={step.id}
                transform={`translate(12 ${i * 88 + 12})`}
                className={`definition-node ${step.id === run.stepId ? "is-current" : ""}`}
                role={step.id === "$complete" ? undefined : "button"}
                tabIndex={step.id === "$complete" ? undefined : 0}
                aria-label={label}
                onClick={() => step.id !== "$complete" && setSelected(step.id)}
                onKeyDown={(e) => {
                  if (
                    step.id !== "$complete" &&
                    ["Enter", " "].includes(e.key)
                  ) {
                    e.preventDefault();
                    setSelected(step.id);
                  }
                }}
              >
                <rect width="298" height="62" rx="10" />
                <text x="12" y="25">
                  {step.title.length > 22
                    ? step.title.slice(0, 21) + "…"
                    : step.title}
                </text>
                <text x="12" y="47" className="definition-node-status">
                  {status} · {step.id}
                </text>
                <title>{label}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <section className="definition-step" aria-label="선택한 단계 계약">
        <h4>
          {detail.title} · {detail.kind}
        </h4>
        <p>{detail.instruction}</p>
        <dl>
          <dt>스킬</dt>
          <dd>{detail.skills.join(" · ") || "지정 없음"}</dd>
          <dt>도구</dt>
          <dd>
            {detail.tools.map((t) => (
              <div key={`${t.server}:${t.name}`}>
                <code>
                  {t.server} / {t.name}
                </code>{" "}
                — {t.purpose}
              </div>
            ))}
          </dd>
          {localGuide && (
            <>
              <dt>로컬 가이드</dt>
              <dd>
                {localGuide.instruction && <p>{localGuide.instruction}</p>}
                {[
                  ...localGuide.docs.map((d) => d.file),
                  ...localGuide.skills,
                  ...localGuide.tools.map((t) => t.name),
                ].join(" · ") || "추가 지시만"}
              </dd>
            </>
          )}
          <dt>입력</dt>
          <dd>{detail.inputs.join(" · ") || "현재 작업의 추적 근거"}</dd>
          <dt>산출물</dt>
          <dd>
            {(detail.id === run.stepId
              ? (run.task?.step?.outputs ?? detail.outputs)
              : detail.outputs
            ).join(" · ") || "사용자 답변 JSON·Markdown"}
          </dd>
          <dt>완료 조건</dt>
          <dd>
            <ul>
              {detail.completion.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </dd>
          <dt>다음 단계</dt>
          <dd>
            {Object.entries(detail.on).map(([outcome, target]) => (
              <div key={outcome}>
                {outcomeNames[outcome]} →{" "}
                {target === "$complete"
                  ? "완료"
                  : steps.find((s) => s.id === target)?.title}
              </div>
            ))}
          </dd>
        </dl>
      </section>
      <details>
        <summary>Codex 세션에서 이어가기</summary>
        <p>
          새 채팅 또는 현재 채팅에 전달하면 같은 실행의 현재 작업을 읽고 이어갈
          수 있어요. 채팅 자체를 자동 연결하거나 새로 실행하지 않습니다.
        </p>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(handoff).then(
              () => setCopied("복사했어요"),
              () => setCopied("아래 내용을 직접 복사해주세요"),
            );
          }}
        >
          이어가기 정보 복사
        </button>
        {copied && <span role="status">{copied}</span>}
        <pre>{handoff}</pre>
      </details>
      <details>
        <summary>실행에 저장된 YAML 정의</summary>
        <pre>{snapshot.source}</pre>
      </details>
    </section>
  );
}
