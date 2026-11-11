import {
  basisLabels,
  defaultBoardQuery,
  sortLabels,
  type BoardQuery,
} from "../model/board-query";
import { projectStageLabels as stageLabels } from "../../../shared/contracts";
import { Segmented } from "../../../shared/ui/primitives";
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
      <div className="board-search">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0" />
        </svg>
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
            className="icon-button small"
            aria-label="검색어 지우기"
            title="검색어 지우기"
            onClick={() => set({ search: "" })}
          >
            ×
          </button>
        )}
      </div>
      <div className="board-control-fields">
        <select
          aria-label="진행 필터"
          title="진행 필터"
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
        <select
          aria-label="날짜 종류"
          title="날짜 종류"
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
        <select
          aria-label="정렬"
          title={
            query.sort === "priority"
              ? "검토 대기 → 편집 중 → 촬영본 선택 → 촬영 완료 → 아이디어 → 게시 완료 순"
              : "정렬"
          }
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
      </div>
      <div className="board-control-summary">
        <span className="ui-meta" aria-live="polite" aria-atomic="true">
          <strong>{count}개</strong> 결과 · 전체 {total}개
        </span>
        <button
          className="small"
          aria-label="전체 콘텐츠 보기"
          aria-pressed={query.stage === "all"}
          onClick={() => set({ search: "", stage: "all", basis: "all" })}
        >
          전체 보기
        </button>
        {filtered && (
          <button
            className="small"
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
        <Segmented
          label="보드 보기 방식"
          size="small"
          className="board-view-switch"
          value={query.view}
          onChange={(view) => set({ view })}
          items={[
            { value: "grid", label: "카드 보기" },
            { value: "list", label: "목록 보기" },
          ]}
        />
      </div>
    </div>
  );
}
