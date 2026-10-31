import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultBoardQuery,
  parseBoardQuery,
  selectBoardProjects,
} from "../../src/features/content-board/model/board-query";
import type { Project } from "../../src/shared/contracts";
const project = (
  id: string,
  date: string,
  extra: Partial<Project> = {},
): Project => ({
  id,
  title: id,
  date,
  stage: "editing",
  nextAction: "",
  publicURL: "",
  shared: false,
  ...extra,
});
test("sorts mixed dates deterministically without rewriting persisted order; undated stay last", () => {
  const input = [
    project("old", "2025-01-01"),
    project("unknown", ""),
    project("new-b", "2026-10-28"),
    project("new-a", "2026-10-28"),
  ];
  const before = JSON.stringify(input);
  assert.deepEqual(
    selectBoardProjects(input, defaultBoardQuery).map((p) => p.id),
    ["new-a", "new-b", "old", "unknown"],
  );
  assert.deepEqual(
    selectBoardProjects(input, { ...defaultBoardQuery, sort: "oldest" }).map(
      (p) => p.id,
    ),
    ["old", "new-a", "new-b", "unknown"],
  );
  assert.equal(JSON.stringify(input), before);
});
test("combines normalized search, stages and explicit date basis without inferring publication dates", () => {
  const input = [
    project("pub", "2026-10-28", {
      stage: "published",
      dateBasis: "publication",
      title: "도쿄 CAFE",
    }),
    project("record", "2026-10-28", {
      stage: "published",
      dateBasis: "record",
      title: "도쿄 CAFE",
    }),
    project("edit", "2026-10-27", {
      title: "도쿄 CAFE",
      nextAction: "표지 확인",
    }),
  ];
  assert.deepEqual(
    selectBoardProjects(input, {
      ...defaultBoardQuery,
      search: " 도쿄 cafe ",
      basis: "publication",
      stage: "all",
    }).map((p) => p.id),
    ["pub"],
  );
  assert.deepEqual(
    selectBoardProjects(input, {
      ...defaultBoardQuery,
      search: "cafe 표지",
      stage: "active",
    }).map((p) => p.id),
    ["edit"],
  );
  assert.deepEqual(
    selectBoardProjects(input, { ...defaultBoardQuery, basis: "unknown" }).map(
      (p) => p.id,
    ),
    ["edit"],
  );
});
test("prioritizes review and editing; invalid saved view values use defaults", () => {
  const input = [
    project("pub", "2026-10-28", { stage: "published" }),
    project("edit", "2026-10-28"),
    project("review", "2025-01-01", { stage: "review" }),
  ];
  assert.deepEqual(
    selectBoardProjects(input, {
      ...defaultBoardQuery,
      stage: "all",
      sort: "priority",
    }).map((p) => p.id),
    ["review", "edit", "pub"],
  );
  assert.deepEqual(
    parseBoardQuery({
      stage: "bad",
      sort: "__proto__",
      basis: "toString",
      search: 1,
    }),
    defaultBoardQuery,
  );
});

test("the default board shows unfinished work and all content is opt-in", () => {
  const input = [
    project("editing", ""),
    project("published", "", { stage: "published" }),
  ];
  assert.deepEqual(
    selectBoardProjects(input, defaultBoardQuery).map((p) => p.id),
    ["editing"],
  );
  assert.equal(
    selectBoardProjects(input, { ...defaultBoardQuery, stage: "all" }).length,
    2,
  );
});
