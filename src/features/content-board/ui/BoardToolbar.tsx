import {
  basisLabels,
  defaultBoardQuery,
  sortLabels,
  stageLabels,
  type BoardQuery,
} from "../model/board-query";
import "./board-controls.css";

export function BoardToolbar({
  query,
  onChange,
  count,
  total,
}: {
  query: BoardQuery;
  onChange: (value: BoardQuery) => void;
  count: number;
  total: number;
}) {
  const set = (patch: Partial<BoardQuery>) => onChange({ ...query, ...patch });
  const filtered = Boolean(
    query.search ||
      query.stage !== defaultBoardQuery.stage ||
      query.basis !== "all",
  );
  return (
    <div className="board-controls">
      <div className="board-control-fields">
        <label className="board-search">
          콘텐츠 검색
          <div>
            <input
              type="search"
              aria-label="콘텐츠 검색"
              placeholder="제목, 다음 할 일, 자료 이름 검색"
              maxLength={300}
              value={query.search}
              onChange={(e) => set({ search: e.target.value })}
            />
            {query.search && (
              <button
                type="button"
                aria-label="검색어 지우기"
                onClick={() => set({ search: "" })}
              >
                ×
              </button>
            )}
          </div>
        </label>
        <label>
          진행 필터
          <select
            aria-label="진행 필터"
            value={query.stage}
            onChange={(e) =>
              set({ stage: e.target.value as BoardQuery["stage"] })
            }
          >
            <option value="active">진행 중 전체</option>
            {Object.entries(stageLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
            <option value="all">전체 콘텐츠</option>
          </select>
        </label>
        <label>
          날짜 종류
          <select
            aria-label="날짜 종류"
            value={query.basis}
            onChange={(e) =>
              set({ basis: e.target.value as BoardQuery["basis"] })
            }
          >
            {Object.entries(basisLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          정렬
          <select
            aria-label="정렬"
            value={query.sort}
            onChange={(e) =>
              set({ sort: e.target.value as BoardQuery["sort"] })
            }
          >
            {Object.entries(sortLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="board-control-summary">
        <span aria-live="polite" aria-atomic="true">
          <strong>{count}개</strong> 결과 · 전체 {total}개
          {query.stage === "active" ? " · 진행 중" : ""}
        </span>
        <div className="board-view-actions">
          <button
            className="quiet"
            aria-label="전체 콘텐츠 보기"
            aria-pressed={query.stage === "all"}
            onClick={() => set({ search: "", stage: "all", basis: "all" })}
          >
            전체 보기
          </button>
          {filtered && (
            <button
              className="quiet"
              onClick={() =>
                onChange({
                  ...defaultBoardQuery,
                  sort: query.sort,
                  view: query.view,
                })
              }
            >
              필터 초기화
            </button>
          )}
          <div
            role="group"
            aria-label="보드 보기 방식"
            className="board-view-switch"
          >
            <button
              aria-pressed={query.view === "grid"}
              onClick={() => set({ view: "grid" })}
            >
              카드 보기
            </button>
            <button
              aria-pressed={query.view === "list"}
              onClick={() => set({ view: "list" })}
            >
              목록 보기
            </button>
          </div>
        </div>
      </div>
      {query.sort === "priority" && (
        <p className="board-sort-hint">
          검토 대기 → 편집 중 → 촬영본 선택 → 촬영 완료 → 아이디어 → 게시 완료
          순으로 보여줘요.
        </p>
      )}
    </div>
  );
}
