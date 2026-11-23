import type { ReactNode } from "react";
import type { TopicBoard } from "./topic-board";
import { boardSummary } from "./topic-summary";
import "./topic-board.css";

type Item = TopicBoard["items"][number];
const askLabels = {
  ready: "올리기 전 확인",
  needs_edit: "확인할 것",
  needs_user: "",
  hold: "결정할 것",
};

function CoverHook({ text }: { text: string }) {
  const lines = text.split(/\s+\/\s+/);
  return (
    <span
      className="topic-hook-lines"
      aria-label={`표지 훅: ${lines.join(" ")}`}
    >
      {lines.map((line, i) => (
        <span key={i}>{line}</span>
      ))}
    </span>
  );
}

function HookAndQuestions({ item }: { item: Item }) {
  const label = askLabels[item.readiness];
  return (
    <>
      <span className="topic-hook">
        <CoverHook text={item.coverHooks[0]} />
      </span>
      {item.asks.length > 0 && (
        <span className={`topic-asks ${item.readiness}`}>
          {label && <strong>{label}</strong>}
          {item.asks.map((ask, i) => (
            <span key={i}>{ask}</span>
          ))}
        </span>
      )}
    </>
  );
}

function TopicCard({
  item,
  showChannel,
  onOpenProject,
}: {
  item: Item;
  showChannel: boolean;
  onOpenProject?: (id: string) => void;
}) {
  const hold = item.readiness === "hold";
  const toggle = `${item.coverHooks.length > 1 ? `표지 +${item.coverHooks.length - 1} · ` : ""}소스·근거`;
  return (
    <details className={`topic-card ${hold ? "topic-hold" : ""}`}>
      <summary
        aria-label={`${item.title} · ${item.readinessLabel} · ${toggle}`}
      >
        <span className="topic-title-row">
          {item.rank != null && (
            <span className="topic-rank" aria-label={`추천 순서 ${item.rank}`}>
              {String(item.rank).padStart(2, "0")}
            </span>
          )}
          <strong className="topic-title">{item.title}</strong>
          {item.decision === "picked" && (
            <span className="topic-picked">선정</span>
          )}
          {hold && (
            <>
              <span className="topic-readiness hold">
                {item.readinessLabel}
              </span>
              <span className="topic-hold-chevron" aria-hidden="true">
                ⌄
              </span>
            </>
          )}
        </span>
        <span className="topic-meta">
          {!hold && (
            <span className={`topic-readiness ${item.readiness}`}>
              {item.readinessLabel}
            </span>
          )}
          {showChannel && (
            <span className="topic-channel">{item.channelLabel}</span>
          )}
          <span className="topic-effort">{item.effortLabel}</span>
          <span className="topic-toggle">
            {toggle} <span aria-hidden="true">⌄</span>
          </span>
        </span>
        {!hold && <HookAndQuestions item={item} />}
      </summary>
      {hold && (
        <div className="topic-held-context">
          <HookAndQuestions item={item} />
        </div>
      )}
      <dl className="topic-facts">
        {item.coverHooks.length > 1 && (
          <>
            <dt>다른 표지 후보</dt>
            <dd className="topic-alternatives">
              {item.coverHooks.slice(1).map((hook, i) => (
                <CoverHook key={i} text={hook} />
              ))}
            </dd>
          </>
        )}
        {item.captionHead && (
          <>
            <dt>캡션 첫 줄</dt>
            <dd>{item.captionHead}</dd>
          </>
        )}
        <dt>훅 계열</dt>
        <dd>{item.hookFamily}</dd>
        {item.basedOn.length > 0 && (
          <>
            <dt>참고한 성과·근거</dt>
            <dd>
              <ul>
                {item.basedOn.map((basis, i) => (
                  <li key={i}>
                    <strong>{basis.title}</strong>
                    <span>{basis.evidence}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>소스</dt>
        <dd>{item.source}</dd>
        {item.hypothesis && (
          <>
            <dt>가설</dt>
            <dd>{item.hypothesis}</dd>
          </>
        )}
        {(onOpenProject || item.projectTitle !== item.title) && (
          <>
            <dt>연결 카드</dt>
            <dd>
              {onOpenProject ? (
                <button
                  type="button"
                  onClick={() => onOpenProject(item.projectId)}
                >
                  {item.projectTitle}
                </button>
              ) : (
                item.projectTitle
              )}
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

export function TopicBoardView({
  board,
  actions,
  onOpenProject,
  notice,
  emptyHint,
}: {
  board?: TopicBoard;
  actions?: (item: Item) => ReactNode;
  onOpenProject?: (id: string) => void;
  notice?: ReactNode;
  emptyHint?: ReactNode;
}) {
  const showChannel =
    new Set(board?.items.map((item) => item.channel)).size > 1;
  return (
    <section
      className="monitor-section topic-selection"
      aria-label="소재 선정"
      data-testid="topic-selection"
    >
      <div className="section-heading">
        <h2>소재 선정</h2>
      </div>
      {notice}
      {board && <p className="topic-summary">{boardSummary(board)}</p>}
      {board?.items.length ? (
        <ol className="topic-list">
          {board.items.map((item) => (
            <li key={`${item.projectId}:${item.id}`}>
              <TopicCard
                item={item}
                showChannel={showChannel}
                onOpenProject={onOpenProject}
              />
              {actions && <div className="topic-actions">{actions(item)}</div>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="topic-empty">
          {emptyHint ?? "아직 등록된 소재 후보가 없어요"}
        </p>
      )}
      {!!board?.counts.dropped && (
        <p className="topic-empty">
          제외한 후보 {board.counts.dropped}개는 카드에 기록만 남겨요.
        </p>
      )}
    </section>
  );
}
