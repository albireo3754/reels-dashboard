import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/contracts";
import {
  editsShareLabel, countEditsCaption, isEditsCaption, maxEditsCaptionLength,
  type EditsConnectionStatus,
  type EditsPermissionPane,
  type EditsFinalShareBridge,
  type EditsShareBlock,
  type EditsShareResult,
} from "../shared/edits-final-share";

const connectedDeviceHelp = "연결된 기기는 지원되는 공식 Codex Computer Use 세션에서 화면과 상태를 확인할 수 있어요. Dashboard의 잠금 확인은 계속 적용돼요.";
const blockedMessage: Record<EditsShareBlock, string> = {
  caption: "Edits의 캡션 반영을 확인하지 못했어요. 공유 창을 다시 확인하면 작성 중인 문안을 이어서 쓸 수 있어요.",
  locked: "Mac을 직접 잠금 해제한 뒤 Edits 창과 결과를 다시 확인하세요.",
  "session-unknown": "잠금 해제를 확인하지 못했어요. Dashboard를 실행한 상태에서 Mac을 직접 잠갔다가 잠금을 해제하고 다시 확인하세요.",
  permission: "시스템 설정에서 Reels Dashboard의 손쉬운 사용 및 화면 기록 권한을 확인하세요.",
  window: "Edits에서 ‘Share to Instagram’ 창을 열고 계정, 캡션, 마지막 Share 버튼을 확인한 다음 다시 확인하세요.",
  changed: "카드나 Edits 창이 바뀌었거나 확인 시간이 지났어요. 새 미리보기를 확인하세요.",
  cancelled: "Share를 누르기 전에 요청을 중단했어요.",
  "target-used": "이 Edits 창에는 이미 게시 요청 기록이 있어요. Instagram에서 결과를 먼저 확인하세요.",
  busy: "다른 Edits 게시 요청을 처리 중이에요. 잠시 후 다시 확인하세요.",
  unavailable: "게시 요청 상태를 읽지 못했어요. 다시 확인해 기록부터 확인하세요.",
};

export function EditsFinalShare({ project, bridge, disabled }: {
  project: Project; bridge: EditsFinalShareBridge; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  return <>
    <button type="button" className="small" disabled={disabled} onClick={() => setOpen(true)}>
      {editsShareLabel}
    </button>
    {open && <ShareDialog project={project} bridge={bridge} onClose={() => setOpen(false)} />}
  </>;
}

type ShareAction = "preview" | "caption" | "confirm" | "recheck";

function ShareDialog({ project, bridge, onClose }: {
  project: Project; bridge: EditsFinalShareBridge; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const token = useRef<string>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const [result, setResult] = useState<EditsShareResult>();
  const [approved, setApproved] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [working, setWorking] = useState<ShareAction>();

  const [draft, setDraft] = useState<string | null>(null);
  const [documentCaption, setDocumentCaption] = useState<string>();
  const [captionApplied, setCaptionApplied] = useState(false);
  const [connection, setConnection] = useState<EditsConnectionStatus>();
  const [checkingConnection, setCheckingConnection] = useState(false);
  const checking = useRef(false);
  const [settingsError, setSettingsError] = useState(false);

  async function checkConnection() {
    if (checking.current || inFlight.current) return;
    checking.current = true;
    setCheckingConnection(true);
    setSettingsError(false);
    try {
      const status = await bridge.connectionStatus();
      if (mounted.current) setConnection(status);
    } catch {
      if (mounted.current) setConnection({ state: "unavailable" });
    } finally {
      checking.current = false;
      if (mounted.current) setCheckingConnection(false);
    }
  }

  async function openSettings(pane: EditsPermissionPane) {
    setSettingsError(false);
    try { await bridge.openPermissionSettings(pane); }
    catch { if (mounted.current) setSettingsError(true); }
  }
  const caption = draft ?? (result?.state === "ready" ? result.caption : "");
  const changed = result?.state === "ready" && caption !== result.caption;
  const validCaption = isEditsCaption(caption);

  function editCaption(value: string) {
    setDraft(value);
    setApproved(false);
    setCaptionApplied(false);
  }

  async function request(mode: ShareAction) {
    if (inFlight.current || checking.current) return;
    const previousToken = token.current;
    if (mode === "confirm" && (!previousToken || changed || !approved)) return;
    if (mode === "caption" && (!previousToken || !changed || !validCaption)) return;
    inFlight.current = true;
    setApproved(false);
    setCancelling(false);
    setWorking(mode);
    try {
      const next = mode === "confirm"
        ? await bridge.confirm(project.id, previousToken!)
        : mode === "caption" ? await bridge.applyCaption(project.id, previousToken!, caption)
        : mode === "recheck" ? await bridge.recheck(project.id) : await bridge.preview(project.id);
      if (!mounted.current) {
        if (next.state === "ready") void bridge.cancel(next.token).catch(() => {});
        return;
      }
      if (next.state === "ready" && mode === "preview") setDocumentCaption(next.documentCaption);
      if (next.state === "ready" && mode === "caption") {
        setDraft(null);
        setCaptionApplied(true);
      }
      token.current = next.state === "ready" ? next.token : undefined;
      setResult(mode === "recheck" && next.state === "blocked" ? { state: "pending" } : next);
    } catch {
      if (mounted.current) {
        token.current = undefined;
        if (mode === "preview" || mode === "caption") setResult({ state: "blocked", reason: mode === "caption" ? "caption" : "unavailable" });
        else setResult({ state: "pending" });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setWorking(undefined);
    }
  }

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void request("preview");
    return () => {
      mounted.current = false;
      if (token.current) void bridge.cancel(token.current).catch(() => {});
    };
  }, []);

  return (
    <dialog ref={dialog} className="ui-dialog project-dialog" data-size="large" aria-label={editsShareLabel}
      onCancel={(event) => {
        event.preventDefault();
        if (working !== "confirm" && working !== "caption") onClose();
      }}>
      <header className="ui-dialog-header"><h2>{editsShareLabel}</h2></header>
      <div className="ui-dialog-body">
        <p><strong>{project.title}</strong></p>
        {working ? (
          <p role="status">{working === "preview" ? "Edits의 공유 창을 확인하고 있어요." : working === "caption" ? "Edits에 캡션을 반영하고 있어요." : "Edits의 게시 결과를 확인하고 있어요."}</p>
        ) : result?.state === "ready" ? (
          <>
            <img src={result.image} alt="Edits의 실제 Instagram 공유 창" style={{ width: "100%", maxHeight: "40vh", objectFit: "contain" }} />
            <p>{result.account}</p>
            <label htmlFor="edits-share-caption">Instagram 캡션</label>
            <textarea id="edits-share-caption" rows={5} value={caption} placeholder="캡션을 입력하세요"
              style={{ width: "100%", resize: "vertical" }} aria-invalid={!validCaption}
              aria-describedby="edits-caption-length" onChange={event => editCaption(event.target.value)} />
            <small id="edits-caption-length">{countEditsCaption(caption)} / {maxEditsCaptionLength}자</small>
            <div className="project-actions">
              {documentCaption && <button type="button" className="secondary small"
                disabled={caption === documentCaption} onClick={() => editCaption(documentCaption)}>카드 문안 불러오기</button>}
              {changed && <button type="button" className="secondary small"
                onClick={() => editCaption(result.caption)}>Edits 내용으로 되돌리기</button>}
              <button type="button" className="small" disabled={!changed || !validCaption}
                onClick={() => void request("caption")}>Edits에 캡션 반영</button>
            </div>
            {captionApplied && <p role="status">Edits에 반영된 캡션을 확인했어요.</p>}
            <label>
              <input type="checkbox" checked={approved} disabled={changed}
                onChange={(event) => setApproved(event.target.checked)} />
              {" "}미리보기의 릴스, 계정, 캡션과 공개 범위를 확인했고 지금 게시하는 데 동의해요.
            </label>
          </>
        ) : result?.state === "blocked" ? (
          <div role="status">
            <p>{blockedMessage[result.reason]}</p>
            {(result.reason === "locked" || result.reason === "session-unknown") && <p>{connectedDeviceHelp}</p>}
          </div>
        ) : result?.state === "pending" ? (
          <div role="status">
            <p>게시 결과 확인 대기 중이에요. 같은 Edits 창을 열어둔 채 결과를 다시 확인하세요. Share를 다시 누르지 마세요.</p>
            {result.reason && <><p>{blockedMessage[result.reason]}</p><p>{connectedDeviceHelp}</p></>}
          </div>
        ) : result?.state === "confirmed" ? (
          <p role="status">Edits에서 게시 성공을 확인했어요. <a href={result.url} target="_blank" rel="noreferrer">Instagram 게시물 보기 ↗</a></p>
        ) : null}
        {!working && result?.state === "blocked" && !["target-used", "busy", "changed", "cancelled"].includes(result.reason) && (
          <section aria-label="Edits 연결 진단">
            <button type="button" className="secondary small" disabled={checkingConnection}
              onClick={() => void checkConnection()}>{checkingConnection ? "권한 확인 중" : "Edits 권한 확인"}</button>
            {connection?.state === "unavailable" && <p role="alert">Edits 연결 도구에 응답이 없어요. Dashboard를 다시 시작한 뒤 확인하세요.</p>}
            {connection?.state === "checked" && <>
              <ul aria-label="Edits 권한 상태" aria-live="polite">
                <li>손쉬운 사용: {connection.accessibility ? "허용됨" : "허용 필요"}</li>
                <li>화면 기록: {connection.screenRecording ? "허용됨" : "허용 필요"}</li>
                <li>Edits: {!connection.installed ? "설치되지 않음" : connection.running ? "실행 중" : "실행되지 않음"}</li>
                <li>화면 잠금: {connection.screen === "locked" ? "잠김" : connection.screen === "unlocked" ? "해제됨" : "확인 불가"}</li>
              </ul>
              {connection.screen !== "locked" && <div className="project-actions">
                {!connection.accessibility && <button type="button" className="secondary small"
                  onClick={() => void openSettings("accessibility")}>손쉬운 사용 설정 열기</button>}
                {!connection.screenRecording && <button type="button" className="secondary small"
                  onClick={() => void openSettings("screen-recording")}>화면 기록 설정 열기</button>}
              </div>}
              <p>권한을 허용한 뒤 다시 확인하세요. macOS가 다시 열기를 요청하면 Dashboard를 재시작하세요. 공유 창 다시 확인은 게시하지 않아요.</p>
            </>}
            {settingsError && <p role="alert">시스템 설정을 열지 못했어요. Mac을 잠금 해제하고 시스템 설정 → 개인정보 보호 및 보안에서 권한을 확인하세요.</p>}
          </section>
        )}
      </div>
      <footer className="ui-dialog-footer">
        {working === "confirm" ? (
          <button type="button" className="secondary small" disabled={cancelling} onClick={() => {
            setCancelling(true);
            if (token.current) void bridge.cancel(token.current).catch(() => setCancelling(false));
          }}>{cancelling ? "중단 확인 중" : "요청 중단"}</button>
        ) : (
          <button type="button" className="secondary small" disabled={working === "caption"} onClick={onClose}>닫기</button>
        )}
        {!working && result?.state === "ready" && (
          <button type="button" disabled={!approved || changed} onClick={() => void request("confirm")}>지금 공개 게시</button>
        )}
        {!working && result?.state === "pending" && (
          <button type="button" onClick={() => void request("recheck")}>게시 결과 다시 확인</button>
        )}
        {!working && result?.state === "blocked" && result.reason !== "target-used" && (
          <button type="button" disabled={checkingConnection} onClick={() => void request("preview")}>공유 창 다시 확인</button>
        )}
      </footer>
    </dialog>
  );
}
