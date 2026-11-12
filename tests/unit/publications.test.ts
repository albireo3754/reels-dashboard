import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary } from "../../src/features/content-library";
import { toSnapshot, validateDashboard } from "../../src/shared/data";
import { mergeProjects } from "../../src/shared/production-project";
import type { ContentInput } from "../../src/shared/local-resources";
import type { Dashboard, Project } from "../../src/shared/contracts";
import {
  defaultBoardQuery,
  parseBoardQuery,
  selectBoardProjects,
} from "../../src/features/content-board/model/board-query";

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  date: "2026-11-01",
  stage: "review",
  nextAction: "",
  publicURL: "",
  shared: false,
  ...extra,
});
const board = (projects: Project[]): Dashboard => ({
  schemaVersion: 1,
  updatedAt: "2026-11-12T00:00:00.000Z",
  projects,
});

test("stored channel state is validated and stays out of the shared snapshot", () => {
  const valid = validateDashboard(
    board([
      project("a", {
        shared: true,
        publications: [
          { channel: "instagram", status: "published", url: "https://example.com/reel", publishedAt: "2026-11-01" },
          { channel: "blog", status: "planned", url: "" },
        ],
      }),
    ]),
  );
  assert.equal(valid.projects[0].publications?.length, 2);
  assert.equal("publications" in toSnapshot(valid).projects[0], false);
  const bad = (publications: unknown) =>
    assert.throws(() =>
      validateDashboard(board([project("a", { publications } as Partial<Project>)])),
    );
  bad([
    { channel: "blog", status: "planned", url: "" },
    { channel: "blog", status: "published", url: "" },
  ]);
  bad([{ channel: "blog", status: "planned", url: "", publishedAt: "2026-11-01" }]);
  bad([{ channel: "blog", status: "published", url: "javascript:alert(1)" }]);
  bad([{ channel: "youtube", status: "published", url: "" }]);
});

test("a channel view judges progress by that channel alone", () => {
  const projects = [
    project("both-live", {
      stage: "published",
      publications: [
        { channel: "instagram", status: "published", url: "" },
        { channel: "naver-clip", status: "published", url: "" },
      ],
    }),
    project("clip-live-instagram-pending", {
      publications: [
        { channel: "instagram", status: "planned", url: "" },
        { channel: "naver-clip", status: "published", url: "" },
      ],
    }),
    project("no-channels"),
  ];
  const ids = (patch: object) =>
    selectBoardProjects(projects, { ...defaultBoardQuery, sort: "title", ...patch }).map((p) => p.id);
  assert.deepEqual(ids({}), ["clip-live-instagram-pending", "no-channels"]);
  assert.deepEqual(ids({ channel: "naver-clip" }), []);
  assert.deepEqual(ids({ channel: "naver-clip", stage: "published" }), [
    "both-live",
    "clip-live-instagram-pending",
  ]);
  assert.deepEqual(ids({ channel: "instagram" }), ["clip-live-instagram-pending"]);
  assert.deepEqual(ids({ channel: "instagram", stage: "review" }), ["clip-live-instagram-pending"]);
  assert.deepEqual(ids({ channel: "naver-clip", stage: "review" }), []);
  assert.deepEqual(ids({ channel: "blog", stage: "all" }), []);
  assert.equal(parseBoardQuery({ channel: "naver-clip" }).channel, "naver-clip");
  assert.equal(parseBoardQuery({ channel: "youtube" }).channel, "all");
});

test("setPublication changes one channel, promotes the stage only when every channel is live, and survives a full upsert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-publication-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const lib = new ContentLibrary(store);
    const content: ContentInput = {
      id: "content-example",
      title: "예시",
      date: "2026-11-01",
      dateBasis: "capture",
      stage: "review",
      nextAction: "",
      publicURL: "",
      localNotes: "note",
      resources: [],
    };
    let state = await lib.upsert(content, (await store.load()).updatedAt);
    const set = async (input: object) =>
      (state = await lib.setPublication({
        projectId: content.id,
        expectedUpdatedAt: state.updatedAt,
        ...input,
      } as Parameters<typeof lib.setPublication>[0]));
    // Targets are registered first: a lone live channel would already complete the project.
    await set({ channel: "instagram", status: "planned" });
    await set({ channel: "naver-clip", status: "published", url: "https://example.com/clip", publishedAt: "2026-11-06" });
    assert.equal(state.project.stage, "review");
    assert.deepEqual(state.project.publications?.map((p) => p.channel), ["instagram", "naver-clip"]);
    assert.equal(state.project.localNotes, "note");
    // A full upsert that does not mention channels keeps them.
    state = await lib.upsert({ ...content, title: "renamed" }, state.updatedAt);
    assert.equal(state.project.publications?.length, 2);
    await set({ channel: "instagram", status: "published", url: "https://example.com/reel" });
    assert.equal(state.project.stage, "published");
    await set({ channel: "blog", status: "planned" });
    assert.equal(state.project.stage, "published");
    await set({ channel: "blog", status: "none" });
    assert.equal(state.project.publications?.length, 2);
    await assert.rejects(
      lib.setPublication({ projectId: content.id, expectedUpdatedAt: "2020-01-01T00:00:00.000Z", channel: "blog", status: "planned" }),
    );
    await assert.rejects(
      lib.setPublication({ projectId: content.id, expectedUpdatedAt: state.updatedAt, channel: "blog", status: "planned", publishedAt: "2026-11-01" }),
    );
    await assert.rejects(
      lib.setPublication({ projectId: "missing", expectedUpdatedAt: state.updatedAt, channel: "blog", status: "planned" }),
      /CONTENT_NOT_FOUND/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merging keeps each channel once and refuses two different live posts on one channel", () => {
  const live = (url: string) => ({ channel: "instagram" as const, status: "published" as const, url });
  const merged = mergeProjects(
    board([
      project("target", { publications: [{ channel: "instagram", status: "planned", url: "" }] }),
      project("source", {
        publications: [live("https://example.com/a"), { channel: "blog", status: "planned", url: "" }],
      }),
    ]),
    "target",
    ["source"],
  );
  assert.deepEqual(merged.projects[0].publications, [
    live("https://example.com/a"),
    { channel: "blog", status: "planned", url: "" },
  ]);
  assert.throws(
    () =>
      mergeProjects(
        board([
          project("target", { publications: [live("https://example.com/a")] }),
          project("source", { publications: [live("https://example.com/b")] }),
        ]),
        "target",
        ["source"],
      ),
    /PROJECT_PUBLICATION_CONFLICT/,
  );
});
