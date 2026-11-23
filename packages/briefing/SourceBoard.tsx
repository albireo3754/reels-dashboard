import type { SourceBoard } from "./source-board";
import "./source-board.css";

const statusLabels = { none: "미제작", draft: "초안", published: "게시 완료" };

export function SourceBoardPanel({ board }: { board: SourceBoard }) {
  return (
    <section className="source-board" aria-label="소스 보드">
      <p className="eyebrow">소스 보드</p>
      <h3>{board.title}</h3>
      <p className="board-basis">{board.basis}</p>
      {board.units.length === 0 && <p>등록된 소재가 없어요.</p>}
      {board.units.map((unit) => (
        <details key={unit.id} className="source-unit">
          <summary>
            <strong className="board-rank">{unit.rank}</strong>
            <span className="unit-overview">
              <strong>{unit.title}</strong>
              <span className="unit-meta">
                {statusLabels[unit.status]} · 영상{" "}
                {unit.footage.score.toFixed(1)}/5
              </span>
              <span>{unit.footage.summary}</span>
            </span>
          </summary>
          <div className="unit-body">
            {unit.statusUrl && (
              <a
                href={unit.statusUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                게시한 릴스 보기
              </a>
            )}
            {unit.footage.scenes.length > 0 && (
              <ul aria-label="촬영 상황" className="scene-chips">
                {unit.footage.scenes.map((scene) => (
                  <li key={scene.id}>
                    {scene.id} · {scene.day}일차 {scene.time} · {scene.title}
                  </li>
                ))}
              </ul>
            )}
            {unit.refs.length === 0 && <p>등록된 레퍼런스가 없어요.</p>}
            {unit.refs.map((ref, i) => (
              <article className="board-ref" key={i}>
                <a href={ref.url} target="_blank" rel="noopener noreferrer">
                  {ref.account} · 인스타에서 보기
                </a>
                <p className="unit-meta">{ref.metric}</p>
                <blockquote>{ref.hook}</blockquote>
                <p>
                  <strong>우리 버전</strong> {ref.ourVersion}
                </p>
              </article>
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}

export function SourceBoardIndex({
  entries,
  onOpen,
}: {
  entries: { projectId: string; board: SourceBoard }[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="source-board board-index" aria-label="소스 보드">
      <h2>소스 보드</h2>
      {entries.length === 0 && (
        <p className="board-basis">등록된 소스 보드가 없어요.</p>
      )}
      {entries.map(({ projectId, board }) => (
        <button key={projectId} onClick={() => onOpen(projectId)}>
          <strong>{board.title}</strong>
          <span>소재 {board.units.length}개</span>
        </button>
      ))}
    </section>
  );
}
