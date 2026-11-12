import { useId, useRef, useState } from "react";
import { Button, Dialog, Notice } from "../shared/ui/primitives";
import { projectWorkPrompt, type WorkbenchBridge } from "../shared/workbench";
import { errorMessage } from "../shared/lib/errors";
import { projectStageLabels, type Project } from "../shared/contracts";
import { projectNextActionGuide } from "../shared/project-next-action";

export function ProjectTerminalDialog({
  project,
  api,
  onClose,
  onSettings,
  onStarted,
}: {
  project: Pick<
    Project,
    "id" | "title" | "stage" | "nextAction" | "publications"
  >;
  api?: WorkbenchBridge;
  onClose: () => void;
  onSettings: () => void;
  onStarted: (id: string) => void;
}) {
  const formId = useId();
  const pending = useRef(false);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const guide = projectNextActionGuide(project);
  const guidedRequest = [request.trim(), guide].filter(Boolean).join("\n\n");
  const guideAdded = request.includes(guide);
  return (
    <Dialog
      open
      onClose={() => {
        if (!pending.current) onClose();
      }}
      title="프로젝트 터미널"
      aria-label="프로젝트 터미널"
      footer={
        api ? (
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {busy ? "여는 중…" : "Codex 터미널 열기"}
          </Button>
        ) : (
          <Button onClick={onSettings}>터미널 설정 열기</Button>
        )
      }
    >
      <p>
        <strong>{project.title}</strong>
      </p>
      {api ? (
        <form
          id={formId}
          className="project-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending.current) return;
            pending.current = true;
            setBusy(true);
            setError("");
            try {
              const session = await api.start({
                kind: "codex",
                phase: "implement",
                permission: "ask",
                project: { id: project.id, title: project.title },
                task: request.trim(),
              });
              onStarted(session.id);
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              pending.current = false;
              setBusy(false);
            }
          }}
        >
          <p className="ui-meta">
            이 프로젝트의 맥락을 새 Codex 세션에 전달해요. 요청을 비워두면
            프로젝트를 확인하고 다음 요청을 기다려요.
          </p>
          <label>
            작업 요청 (선택)
            <textarea
              autoFocus
              value={request}
              maxLength={8000}
              disabled={busy}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="예: 이 프로젝트의 자막을 검토하고 수정해줘."
            />
          </label>
          <p className="ui-meta">
            현재 단계 · {projectStageLabels[project.stage]} / 다음 할 일 ·{" "}
            {project.nextAction || "미정"}
          </p>
          <Button
            disabled={busy || guideAdded || guidedRequest.length > 8000}
            onClick={() => setRequest(guidedRequest)}
          >
            {guideAdded ? "다음 작업 가이드 넣음" : "다음 작업 가이드 넣기"}
          </Button>
          <p className="ui-meta">
            단계에 맞는 작업 순서와 확인 기준을 요청에 추가해요. 내용을 수정한
            뒤 터미널을 열 수 있어요.
          </p>
          {!guideAdded && guidedRequest.length > 8000 && (
            <Notice>
              가이드를 추가하려면 작업 요청을 줄여주세요. 최대 8,000자까지
              입력할 수 있어요.
            </Notice>
          )}
          <details>
            <summary>전달할 맥락과 요청</summary>
            <pre className="project-terminal-prompt">
              {projectWorkPrompt(project, request)}
            </pre>
          </details>
          {error && <Notice tone="danger">{error}</Notice>}
        </form>
      ) : (
        <Notice>
          설정에서 ‘터미널 사용’을 켜고 앱을 다시 실행하면 이 프로젝트의
          터미널을 열 수 있어요.
        </Notice>
      )}
    </Dialog>
  );
}
