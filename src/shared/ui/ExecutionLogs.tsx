import { koreanDateTime } from "../lib/format";
import { useEffect, useState } from "react";
import {
  executionStatusLabels,
  type ExecutionLog,
  type ExecutionLogBridge,
} from "../execution-log";
import "./execution-logs.css";

const time = (value: string) => koreanDateTime(value);
export function ExecutionLogView({ log }: { log: ExecutionLog }) {
  return (
    <article className="execution-log" data-status={log.status}>
      <header>
        <strong>{log.label}</strong>
        <span>{executionStatusLabels[log.status]}</span>
      </header>
      <p>
        {time(log.startedAt)} 시작 ·{" "}
        {log.endedAt
          ? `${time(log.endedAt)} ${log.status === "interrupted" ? "관측 중단 확인" : "종료"}`
          : `${time(log.updatedAt)} 마지막 갱신`}
      </p>
      {log.progress !== undefined && (
        <label>
          진행률 {Math.round(log.progress)}%{" "}
          <progress max={100} value={log.progress} />
        </label>
      )}
      {log.status === "interrupted" && (
        <p>
          앱과의 연결이 끊겼어요. 실제 프로세스 종료 여부는 확인되지 않았어요.
        </p>
      )}
      {log.persistenceError && <p role="alert">{log.persistenceError}</p>}
      <details>
        <summary>실행 상세와 로그</summary>
        <dl>
          <dt>서비스</dt>
          <dd>{log.source}</dd>
          <dt>실행 프로그램</dt>
          <dd>{log.executable}</dd>
          {log.pid !== undefined && (
            <>
              <dt>직접 실행한 PID</dt>
              <dd>{log.pid}</dd>
            </>
          )}
          <dt>기록 ID</dt>
          <dd>{log.id}</dd>
          {log.projectId && (
            <>
              <dt>프로젝트</dt>
              <dd>{log.projectId}</dd>
            </>
          )}
          {log.jobId && (
            <>
              <dt>상위 작업</dt>
              <dd>{log.jobId}</dd>
            </>
          )}
          {log.exitCode !== undefined && (
            <>
              <dt>종료 코드</dt>
              <dd>{log.exitCode}</dd>
            </>
          )}
          {log.signal && (
            <>
              <dt>종료 신호</dt>
              <dd>{log.signal}</dd>
            </>
          )}
        </dl>
        <ol>
          {log.events.map((event, index) => (
            <li key={index}>
              <time>{time(event.at)}</time> {event.message}
            </li>
          ))}
        </ol>
        {log.output && <pre aria-label="진단 출력">{log.output}</pre>}
      </details>
    </article>
  );
}

export function ExecutionLogsPanel({ bridge }: { bridge: ExecutionLogBridge }) {
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await bridge.list();
        if (!cancelled) {
          setLogs(next);
          setError("");
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 1500);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bridge]);
  const running = logs.filter((log) => log.status === "running").length;
  const visible = logs.filter(
    (log) =>
      filter === "all" ||
      (filter === "running"
        ? log.status === "running"
        : log.status !== "running"),
  );
  return (
    <section className="execution-logs" aria-label="실행 로그">
      <h2>실행 로그</h2>
      <p>
        앱에서 시작한 영상 처리 기록이에요. 실행 중 {running}개 · 종료 기록{" "}
        {logs.length - running}개
      </p>
      <p>
        프로세스 완료는 해당 처리 단계의 종료를 뜻해요. 최종 파일 저장 결과는
        편집 화면에서 확인하세요.
      </p>
      <label>
        표시{" "}
        <select
          aria-label="로그 표시"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">전체</option>
          <option value="running">실행 중</option>
          <option value="finished">종료 이력</option>
        </select>
      </label>
      {error && (
        <p role="alert">
          로그를 갱신하지 못했어요: {error}
          {loaded ? " · 마지막 조회 결과를 표시하고 있어요." : ""}
        </p>
      )}
      {!loaded && !error && <p role="status">기록을 불러오는 중이에요.</p>}
      {loaded && !error && visible.length === 0 && (
        <p>표시할 실행 기록이 없어요.</p>
      )}
      {visible.map((log) => (
        <ExecutionLogView key={log.id} log={log} />
      ))}
    </section>
  );
}
