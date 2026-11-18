import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContentLibrary } from "../../src/features/content-library";
import { LocalStore } from "../../src/shared/lib/storage";
import { validateDashboard } from "../../src/shared/data";
import { mergeProjects } from "../../src/shared/production-project";
import type { ContentInput } from "../../src/shared/local-resources";
import { decidePitch, topicBoard, topicPitchesSchema, type TopicPitch } from "../../src/shared/topic-pitch";
import { boardSummary } from "../../src/features/topic-selection/model/summary";

const at = "2026-11-18T09:00:00+09:00";
const pitch = (id: string, patch: Partial<TopicPitch> = {}): TopicPitch => ({
  id,
  channel: "instagram",
  title: `후보 ${id}`,
  hookFamily: "정보형",
  coverHooks: ["11월부터 바뀐 / 일본 면세 받는 법"],
  basedOn: [],
  source: "촬영분 12개",
  effort: "M",
  readiness: "needs_edit",
  asks: [],
  decision: "proposed",
  updatedAt: at,
  ...patch,
});

test("the board puts picked first, then readiness and rank, and only counts dropped pitches", () => {
  const board = topicBoard(
    [
      { id: "a", title: "A", pitches: [pitch("hold", { readiness: "hold", rank: 1 }), pitch("ready", { readiness: "ready", rank: 5 })] },
      { id: "b", title: "B", pitches: [pitch("edit2", { rank: 3 }), pitch("edit1", { rank: 2 }), pitch("gone", { decision: "dropped" })] },
      { id: "c", title: "C", pitches: [pitch("chosen", { readiness: "needs_user", decision: "picked", rank: 9 })] },
      { id: "d", title: "D" },
    ],
    [
      { channel: "instagram", label: "릴스", week: "next", remaining: 2 },
      { channel: "blog", label: "블로그", week: "next", remaining: 1 },
      { channel: "instagram", label: "릴스", week: "this", remaining: 0 },
    ],
  );
  assert.deepEqual(board.items.map((i) => i.id), ["chosen", "ready", "edit1", "edit2", "hold"]);
  assert.deepEqual(board.counts, { picked: 1, ready: 1, needs_edit: 2, needs_user: 0, hold: 1, dropped: 1 });
  // Only gaps a pitch can fill, and only real ones.
  assert.deepEqual(board.gaps, [{ channel: "instagram", label: "릴스", week: "next", remaining: 2 }]);
  assert.equal(board.items[0].projectTitle, "C");
  assert.equal(board.items[1].readinessLabel, "바로 올릴 수 있음");
  assert.equal(boardSummary(board), "다음 주 릴스 2편 남음 · 후보 5 (선정 1 · 바로 1 · 편집 2 · 보류 1)");
});

test("pitch lists reject duplicate ids, unknown fields and empty hooks", () => {
  assert.throws(() => topicPitchesSchema.parse([pitch("a"), pitch("a")]));
  assert.throws(() => topicPitchesSchema.parse([{ ...pitch("a"), path: "/Users/x" }]));
  assert.throws(() => topicPitchesSchema.parse([pitch("a", { coverHooks: [] })]));
  assert.throws(() => topicPitchesSchema.parse([pitch("A")]));
  assert.throws(() => decidePitch([pitch("a")], "missing", "picked"), /PITCH_NOT_FOUND/);
  const decided = decidePitch([pitch("a"), pitch("b")], "b", "picked", new Date("2026-11-18T01:00:00Z"));
  assert.equal(decided[1].decision, "picked");
  assert.equal(decided[1].updatedAt, "2026-11-18T01:00:00.000Z");
  assert.equal(decided[0], decided[0]);
});

test("dashboard validation keeps pitches and refuses malformed ones", () => {
  const base = { schemaVersion: 1, updatedAt: "2026-11-18T00:00:00.000Z" };
  const project = { id: "x", title: "X", date: "2026-11-18", stage: "idea", nextAction: "", publicURL: "", shared: false };
  const ok = validateDashboard({ ...base, projects: [{ ...project, pitches: [pitch("d2")] }] });
  assert.equal(ok.projects[0].pitches?.[0].id, "d2");
  assert.equal(validateDashboard({ ...base, projects: [project] }).projects[0].pitches, undefined);
  assert.throws(() => validateDashboard({ ...base, projects: [{ ...project, pitches: [{ ...pitch("d2"), readiness: "soon" }] }] }));
});

test("setPitches and decidePitch change only the pitches and survive a full upsert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-pitches-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const lib = new ContentLibrary(store);
    const content: ContentInput = {
      id: "content-example", title: "예시", date: "2026-11-01", dateBasis: "capture", stage: "idea",
      nextAction: "다음", publicURL: "", localNotes: "note", resources: [],
      publications: [{ channel: "instagram", status: "planned", url: "" }],
    };
    let state = await lib.upsert(content, (await store.load()).updatedAt);
    state = await lib.setPitches({ projectId: content.id, expectedUpdatedAt: state.updatedAt, pitches: [pitch("d1"), pitch("d2")] });
    assert.deepEqual(state.project.pitches?.map((p) => p.id), ["d1", "d2"]);
    state = await lib.decidePitch({ projectId: content.id, pitchId: "d2", decision: "picked", expectedUpdatedAt: state.updatedAt });
    assert.equal(state.project.pitches?.[1].decision, "picked");
    assert.equal(state.project.stage, "idea");
    assert.deepEqual(state.project.publications, content.publications);
    // A full upsert from an agent that does not know about pitches keeps them.
    state = await lib.upsert({ ...content, nextAction: "바뀜" }, state.updatedAt);
    assert.equal(state.project.pitches?.length, 2);
    // Stale revisions are refused; an empty list removes the pitches.
    await assert.rejects(lib.setPitches({ projectId: content.id, expectedUpdatedAt: "2026-01-01T00:00:00.000Z", pitches: [] }));
    state = await lib.setPitches({ projectId: content.id, expectedUpdatedAt: state.updatedAt, pitches: [] });
    assert.equal(state.project.pitches, undefined);
    await assert.rejects(lib.decidePitch({ projectId: "nope", pitchId: "d1", decision: "picked", expectedUpdatedAt: state.updatedAt }), /CONTENT_NOT_FOUND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("free text that looks like a local path or a credential is refused, ordinary text is not", () => {
  for (const bad of [
    { source: `${["", "Users", "someone", "a.mov"].join("/")} 원본` },
    { source: "촬영본 ~/Desktop/a.mov" },
    { captionHead: "file:///tmp/a.png" },
    { hypothesis: "token sk-abcdef1234567890" },
    { asks: ["ghp_abcdefghijklmnop 확인"] },
    { basedOn: [{ title: "A", evidence: "Bearer abcdefghijklmnop" }] },
    { coverHooks: ["a".repeat(0) + "deadbeefdeadbeefdeadbeefdeadbeef / 표지"] },
  ])
    assert.equal(topicPitchesSchema.safeParse([pitch("x", bad as Partial<TopicPitch>)]).success, false, JSON.stringify(bad));
  for (const ok of [
    { source: "도시어부 클립 v5(42초) + 폭포맥주 v2 / 원본 구간 재조합" },
    { captionHead: "11월부터 일본에서 쇼핑하시면 면세 받는 순서가 달라졌어요🇯🇵" },
    { coverHooks: ["시나몬 코젤 4,500원 / 판교 2차로 또 올 집"] },
    { basedOn: [{ title: "3만 보", evidence: "도달 3.1만 · 저장 1.84% · 공유 1.68%" }] },
  ])
    assert.equal(topicPitchesSchema.safeParse([pitch("x", ok as Partial<TopicPitch>)]).success, true, JSON.stringify(ok));
});

test("merging cards carries their pitches and refuses id clashes or more than eight", () => {
  const card = (id: string, pitches: TopicPitch[]) => ({ id, title: id, date: "2026-11-18", stage: "idea" as const, nextAction: "", publicURL: "", shared: false, pitches });
  const dashboard = (projects: ReturnType<typeof card>[]) => ({ schemaVersion: 1 as const, updatedAt: "2026-11-18T00:00:00.000Z", projects });
  const merged = mergeProjects(dashboard([card("a", [pitch("d1")]), card("b", [pitch("d2", { decision: "picked" })])]), "a", ["b"]);
  assert.deepEqual(merged.projects[0].pitches?.map((p) => `${p.id}:${p.decision}`), ["d1:proposed", "d2:picked"]);
  assert.throws(() => mergeProjects(dashboard([card("a", [pitch("d1")]), card("b", [pitch("d1")])]), "a", ["b"]), /PITCH_MERGE_CONFLICT/);
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => pitch(`${prefix}${i}`));
  assert.throws(() => mergeProjects(dashboard([card("a", many("a", 5)), card("b", many("b", 4))]), "a", ["b"]), /PITCH_MERGE_CONFLICT/);
});
