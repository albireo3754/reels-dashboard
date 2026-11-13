import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  readFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EditsAutomation,
  decodeEditsComposition,
  readEditsMedia,
  verifyEditsMediaSource,
  type EditsClip,
  type EditsProject,
  type EditsMedia,
} from "../../src/features/edits-automation";
import type {
  AXNode,
  AXSnapshot,
  EditsNativeOperation,
} from "../../src/shared/edits";

const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  third = "33333333-3333-4333-8333-333333333333";
const target = {
  pid: 123,
  root: "application" as const,
  path: [0],
  fingerprint: "observed",
};
const node = (n: Partial<AXNode> = {}, position = 0): AXNode => ({
  target: { ...target, path: [position] },
  role: "AXButton",
  title: "",
  description: "",
  identifier: "",
  help: "",
  value: null,
  enabled: true,
  selected: false,
  focused: false,
  settable: false,
  actions: [{ name: "AXPress", description: "press" }],
  frame: null,
  ...n,
});
const snap = (nodes: AXNode[]): AXSnapshot => ({
  pid: 123,
  nodes,
  truncated: false,
  diagnostics: {
    counts: {},
    samples: [],
    samplesOmitted: 0,
    confirmedAbsentSubroles: 0,
    confirmedAbsentSubroleSamples: [],
  },
});
const clip = (n: Partial<EditsClip> = {}): EditsClip => ({
  id,
  kind: "video",
  start: 0,
  duration: 5,
  sourceIn: 0,
  sourceOut: 5,
  sourceDuration: 10,
  volume: 1,
  muted: false,
  includeAudio: true,
  ...n,
});
const project = (clips: EditsClip[], projectId = id): EditsProject => ({
  id: projectId,
  clips,
  source: "read-only Timeline.db",
});

test("status preserves explicit lock booleans and unknown without truthiness coercion", async () => {
  for (const screenLocked of [true, false, "unknown"] as const) {
    const service = new EditsAutomation({
      invoke: async () => ({ trusted: false, screenLocked }),
    });
    const result = (await service.request("reels_edits_status", {})) as any;
    assert.equal(result.screenLocked, screenLocked);
  }
  for (const screenLocked of [undefined, null, 0, 1, "true"]) {
    const service = new EditsAutomation({
      invoke: async () => ({ trusted: false, screenLocked }),
    });
    await assert.rejects(
      service.request("reels_edits_status", {}),
      /HELPER_PROTOCOL/,
    );
  }
});

test("open-project checks the conjunction of ID and name, including already-open paths", async () => {
  for (const [requestedID, name, actualID, actualName, success] of [
    [id, "Example", other, "Example", false],
    [id, "Wrong name", id, "Example", false],
    [id, "Example", id, "Example", true],
  ] as const) {
    const service = new EditsAutomation(
      {
        invoke: async (op) => {
          if (op !== "tree")
            throw new Error(
              "navigation cannot establish a different mock project",
            );
          return snap([
            node({ identifier: "editor.title", value: actualName }),
          ]);
        },
      },
      { project: async () => project([clip()], actualID) },
    );
    const result = service.request("reels_edits_open_project", {
      projectId: requestedID,
      name,
    });
    if (success) assert.equal(((await result) as any).alreadyOpen, true);
    else await assert.rejects(result);
  }
});

test("volume tools refuse the wrong or unknown object kind before selection or writes", async () => {
  for (const [tool, kind, args] of [
    ["reels_edits_audio_volume", "video", { trackId: id, decibels: -70 }],
    ["reels_edits_clip_mute", "music", { clipId: id, muted: true }],
    ["reels_edits_audio_volume", "text", { trackId: id, decibels: 0 }],
  ] as const) {
    const calls: string[] = [];
    const service = new EditsAutomation(
      {
        invoke: async (op) => {
          calls.push(op);
          return snap([node({ identifier: id })]);
        },
      },
      { project: async () => project([clip({ kind })]) },
    );
    await assert.rejects(service.request(tool, args), /KIND_MISMATCH/);
    assert.ok(calls.every((op) => op === "tree"));
  }
  const calls: string[] = [];
  const service = new EditsAutomation(
    {
      invoke: async (op) => {
        calls.push(op);
        return snap([node({ identifier: id })]);
      },
    },
    { project: async () => null },
  );
  await assert.rejects(
    service.request("reels_edits_clip_mute", { clipId: id }),
    /METADATA_UNAVAILABLE/,
  );
  assert.deepEqual(calls, ["tree"]);
});

test("audio-volume verifies the music object's persisted gain while preserving video sound", async () => {
  let selected = false,
    level = 0;
  const state = () =>
    project([
      clip({ id: other }),
      clip({ kind: "music", volume: 10 ** (level / 20) }),
    ]);
  const tree = () =>
    snap([
      node({ identifier: id, selected }),
      node({ identifier: other }, 1),
      node(
        {
          role: "AXSlider",
          description: "Volume value",
          value: level,
          settable: true,
        },
        2,
      ),
    ]);
  const service = new EditsAutomation(
    {
      invoke: async (op, args) => {
        if (op === "press") {
          assert.equal((args.target as typeof target).path[0], 0);
          selected = true;
        }
        if (op === "set-value") level = Number(args.value);
        return tree();
      },
    },
    { project: async () => state() },
  );
  const result = (await service.request("reels_edits_audio_volume", {
    trackId: id,
    decibels: -6,
  })) as any;
  assert.equal(result.kind, "music");
  assert.equal(result.project.clips[0].volume, 1);
  assert.ok(
    Math.abs(result.project.clips[1].volume - 10 ** (-6 / 20)) < 0.0001,
  );
});

test("text add/set verifies the actual new/requested object, never only its inspector field", async () => {
  for (const mode of ["add", "set"] as const)
    for (const apply of [false, true]) {
      let input = "old",
        created = false;
      const desired = "Exact first line\nExact second line";
      const state = () =>
        project([
          clip(),
          clip({ id: third, kind: "text", text: desired }),
          ...(mode === "set" || created
            ? [clip({ id: other, kind: "text", text: apply ? input : "old" })]
            : []),
        ]);
      const tree = () =>
        snap([
          node({ identifier: id }),
          node({ identifier: third, title: desired }, 1),
          node({ title: "Text" }, 2),
          node({ title: "None" }, 3),
          node(
            { role: "AXTextArea", value: input, settable: true, focused: true },
            4,
          ),
          ...(mode === "set" || created
            ? [
                node(
                  {
                    identifier: other,
                    title: apply ? input : "old",
                    selected: true,
                  },
                  5,
                ),
              ]
            : []),
        ]);
      const native = {
        invoke: async (
          op: EditsNativeOperation,
          args: Record<string, unknown>,
        ) => {
          if (
            op === "press" &&
            (args.target as typeof target).path[0] === 3 &&
            apply
          )
            created = true;
          if (op === "set-value") input = String(args.value);
          return tree();
        },
      };
      const service = new EditsAutomation(native, {
        project: async () => state(),
        timeoutMs: 10,
        pollMs: 1,
      });
      const result =
        mode === "add"
          ? service.request("reels_edits_text_add", { text: desired })
          : service.request("reels_edits_text_set", {
              clipId: other,
              text: desired,
            });
      if (apply) {
        const actual = (await result) as any;
        assert.equal(actual.textObject.id, other);
        assert.equal(actual.textObject.text, desired);
      } else await assert.rejects(result, /VERIFICATION_FAILED/);
    }
  const decoded = decodeEditsComposition({
    tracks: [
      { elements: [{ id, content: { text: { _0: { text: "a\nb" } } } }] },
    ],
  });
  assert.equal(decoded[0].text, "a\nb");
});

test("import proves a new persisted alias/source after chooser closure without claiming panel visibility", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-import-regression-"));
  try {
    const source = path.join(root, "example.mov"),
      wrong = path.join(root, "different.mov");
    await writeFile(source, "source");
    await writeFile(wrong, "source");
    for (const mode of [
      "dialog-stays",
      "no-alias",
      "wrong-source",
      "unrelated-ui",
      "no-panel",
      "success",
    ] as const) {
      let dialog = false,
        imported = false,
        input = "",
        presses = 0;
      const asset: EditsMedia = {
        aliasId: other,
        assetId: third,
        name: path.basename(source),
        sourcePath: mode === "wrong-source" ? wrong : source,
        bytes: 6,
        managed: false,
      };
      const tree = () =>
        snap([
          node({ identifier: id }),
          ...(mode !== "no-panel"
            ? [node({ title: "Media", selected: !dialog }, 1)]
            : []),
          ...(dialog
            ? [
                node({ role: "AXSheet" }, 5),
                node(
                  {
                    role: "AXTextField",
                    value: input,
                    settable: true,
                    focused: true,
                  },
                  2,
                ),
                node({ title: "Import" }, 3),
              ]
            : mode === "no-panel"
              ? []
              : [
                  node(
                    {
                      role: "AXStaticText",
                      title: "Media",
                      target: { ...target, path: [1, 0] },
                    },
                    4,
                  ),
                ]),
          ...(imported && mode !== "no-panel"
            ? [
                node(
                  {
                    identifier: third,
                    title: path.basename(source),
                    target: {
                      ...target,
                      path: mode === "unrelated-ui" ? [9, 0] : [6],
                    },
                  },
                  6,
                ),
              ]
            : []),
        ]);
      const native = {
        invoke: async (
          op: EditsNativeOperation,
          args: Record<string, unknown>,
        ) => {
          if (op === "menu") dialog = true;
          if (op === "set-value") input = String(args.value);
          if (op === "press" && (args.target as typeof target).path[0] === 3) {
            presses++;
            if (mode !== "dialog-stays") {
              dialog = false;
              imported = true;
            }
          }
          return tree();
        },
      };
      const service = new EditsAutomation(native, {
        project: async () => project([clip()]),
        media: async () => (imported && mode !== "no-alias" ? [asset] : []),
        timeoutMs: 15,
        pollMs: 1,
      });
      const result = service.request("reels_edits_import_media", {
        paths: [source],
      });
      if (["success", "unrelated-ui", "no-panel"].includes(mode)) {
        const verified = (await result) as any;
        assert.equal(verified.verification.kind, "persisted-media-import");
        assert.equal(verified.mediaPanelVisibility, "not-assessed");
        assert.equal(
          verified.imported[0].identity.method,
          "canonical-path+size",
        );
      } else await assert.rejects(result, /VERIFICATION_FAILED/);
      assert.equal(presses, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search distinguishes fresh same results, explicit empty results and unconfirmed views", async () => {
  for (const mode of [
    "same-complete",
    "same-unconfirmed",
    "empty-complete",
    "empty-unconfirmed",
  ] as const) {
    let query = "old query";
    const field = () =>
      node({ role: "AXTextField", value: query, settable: true }, 1);
    const tree = () =>
      snap([
        node({ title: "Audio" }),
        field(),
        ...(query === "old query" || mode.startsWith("same")
          ? [
              node({ role: "AXList" }, 2),
              node({ title: "Song, Artist, · 3:00" }, 3),
            ]
          : []),
        ...(query !== "old query" && mode === "empty-complete"
          ? [node({ role: "AXStaticText", title: "No results found" }, 4)]
          : []),
      ]);
    const native = {
      invoke: async (
        op: EditsNativeOperation,
        args: Record<string, unknown>,
      ) => {
        if (op === "find") return { snapshot: tree(), matches: [field()] };
        if (op === "set-value") {
          query = String(args.value);
          if (mode === "same-complete")
            return {
              after: snap([
                field(),
                node({ role: "AXProgressIndicator", title: "Searching" }, 5),
              ]),
            };
        }
        return tree();
      },
    };
    const service = new EditsAutomation(native, { timeoutMs: 15, pollMs: 1 });
    const result = (await service.request("reels_edits_audio_search", {
      query: "new query",
    })) as any;
    assert.equal(
      result.verified,
      mode.endsWith("complete") && !mode.endsWith("unconfirmed"),
    );
    if (mode === "empty-complete") {
      assert.deepEqual(result.results, []);
      assert.equal(result.completion, "visible-empty-state");
    }
    if (mode.endsWith("unconfirmed"))
      assert.equal(result.completion, "unconfirmed");
  }
});

test("repeating an unconfirmed query cannot promote the same stale list to verified", async () => {
  let query = "old query",
    typing = 0,
    loading = false;
  const field = () =>
    node({ role: "AXTextField", value: query, settable: true }, 1);
  const tree = () =>
    snap([
      node({ title: "Audio" }),
      field(),
      node({ role: "AXList" }, 2),
      node({ title: "Old song, Artist, · 3:00" }, 3),
      ...(loading
        ? [node({ role: "AXProgressIndicator", title: "Searching" }, 4)]
        : []),
    ]);
  const native = {
    invoke: async (op: EditsNativeOperation, args: Record<string, unknown>) => {
      if (op === "find") {
        const result = { snapshot: tree(), matches: [field()] };
        loading = false;
        return result;
      }
      if (op === "set-value") {
        typing++;
        query = String(args.value);
      }
      return tree();
    },
  };
  const service = new EditsAutomation(native, { timeoutMs: 15, pollMs: 1 });
  for (let i = 0; i < 2; i++) {
    const result = (await service.request("reels_edits_audio_search", {
      query: "new query",
    })) as any;
    assert.equal(result.verified, false);
    assert.equal(result.completion, "unconfirmed");
  }
  // A fresh client has no previous proof either: the query field is insufficient.
  const fresh = new EditsAutomation(native, { timeoutMs: 15, pollMs: 1 });
  assert.equal(
    (
      (await fresh.request("reels_edits_audio_search", {
        query: "new query",
      })) as any
    ).verified,
    false,
  );
  assert.equal(typing, 1);
  // An actual subsequently observed loading/response transition can verify it.
  loading = true;
  const completed = (await service.request("reels_edits_audio_search", {
    query: "new query",
  })) as any;
  assert.equal(completed.verified, true);
  assert.equal(completed.completion, "observed-results");
});

test("Media index reads stay read-only and managed-copy identity requires exact bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-media-index-"));
  try {
    const library = path.join(root, "example.bsledits"),
      folder = path.join(library, "Projects", id);
    await mkdir(folder, { recursive: true });
    await mkdir(path.join(library, "Media/Original"), { recursive: true });
    const source = path.join(root, "source.mov"),
      copy = path.join(library, "Media/Original/copy.mov");
    await writeFile(source, "source");
    await copyFile(source, copy);
    const index = path.join(folder, "MediaIndex.db"),
      assets = path.join(library, "Media.db");
    const a = new DatabaseSync(index);
    a.exec(
      "CREATE TABLE media_aliases(id TEXT,asset_id TEXT,display_name TEXT)",
    );
    a.prepare("INSERT INTO media_aliases VALUES(?,?,?)").run(
      other,
      third,
      "source.mov",
    );
    a.close();
    const b = new DatabaseSync(assets);
    b.exec(
      "CREATE TABLE media_assets(id TEXT,name TEXT,storage_mode TEXT,source_path TEXT,file_size INTEGER,is_available INTEGER)",
    );
    b.prepare("INSERT INTO media_assets VALUES(?,?,?,?,?,1)").run(
      third,
      "source.mov",
      "managed",
      "Original/copy.mov",
      6,
    );
    b.close();
    const before = [await readFile(index), await readFile(assets)];
    const items = await readEditsMedia(id, root);
    assert.equal(
      (await verifyEditsMediaSource(items[0], source))?.method,
      "managed-copy-sha256",
    );
    await writeFile(copy, "wrong!");
    assert.equal(await verifyEditsMediaSource(items[0], source), null);
    assert.deepEqual(await readFile(index), before[0]);
    assert.deepEqual(await readFile(assets), before[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
