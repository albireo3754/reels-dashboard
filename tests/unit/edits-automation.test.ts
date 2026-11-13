import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  chmod,
  rm,
  mkdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EditsAutomation,
  readEditsProject,
  decodeEditsComposition,
} from "../../src/features/edits-automation";
import {
  editsTools,
  type AXNode,
  type AXSnapshot,
  type EditsNativeOperation,
} from "../../src/shared/edits";
import { EditsNativeClient } from "../../src/desktop/edits-native";
import {
  createAgentDispatch,
  type AgentPorts,
} from "../../src/features/agent-tools";
import { toolGroupOf } from "../../src/app/cli/tool-groups";
import { toolSlug } from "../../src/app/cli/tool-command";

const id = "11111111-1111-4111-8111-111111111111";
const target = {
  pid: 123,
  root: "application" as const,
  path: [0],
  fingerprint: "example",
};
const node = (values: Partial<AXNode> = {}): AXNode => ({
  target,
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
  ...values,
});
const snapshot = (nodes: AXNode[]): AXSnapshot => ({
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
const clip = {
  id,
  kind: "video",
  start: 0,
  duration: 5,
  sourceIn: 10,
  sourceOut: 15,
  sourceDuration: 20,
  volume: 1,
  muted: false,
  includeAudio: true,
};

test("all Edits tools share the CLI filter, flat slugs and validated concrete targets", () => {
  for (const name of Object.keys(editsTools) as (keyof typeof editsTools)[])
    assert.equal(toolGroupOf[name], "edits");
  assert.equal(toolSlug("reels_edits_status"), "edits-status");
  assert.throws(() =>
    editsTools.reels_edits_ax_press.input.parse({
      target: { ...target, root: undefined },
      intent: "editor-control",
    }),
  );
  assert.throws(() =>
    editsTools.reels_edits_ax_press.input.parse({ target, intent: "anything" }),
  );
  assert.throws(() =>
    editsTools.reels_edits_ax_press.input.parse({
      target,
      intent: "editor-control",
      action: "AXDelete",
    }),
  );
  assert.throws(() =>
    editsTools.reels_edits_menu.input.parse({
      path: "File>Share to Instagram",
    }),
  );
  assert.throws(() => editsTools.reels_edits_open_project.input.parse({}));
  assert.throws(() =>
    editsTools.reels_edits_clip_trim.input.parse({
      clipId: id,
      inSeconds: 4,
      outSeconds: 3,
    }),
  );
});

test("every dryRun is status plus plan only, including export and raw actions", async () => {
  const calls: string[] = [];
  const service = new EditsAutomation({
    invoke: async (op) => {
      calls.push(op);
      return { trusted: false, running: false, screenLocked: "unknown" };
    },
  });
  const examples: Record<string, unknown> = {
    reels_edits_ax_press: { target, intent: "editor-control" },
    reels_edits_ax_set_value: {
      target,
      intent: "audio-search",
      value: "example",
    },
    reels_edits_menu: { path: "File>Import Media" },
    reels_edits_open_project: { name: "Example" },
    reels_edits_import_media: { paths: ["/abs/example.mov"] },
    reels_edits_clip_trim: { clipId: id, inSeconds: 1, outSeconds: 2 },
    reels_edits_clip_mute: { clipId: id },
    reels_edits_text_add: { text: "Example" },
    reels_edits_text_set: { clipId: id, text: "Example" },
    reels_edits_audio_search: { query: "Example" },
    reels_edits_audio_add: { resultLabel: "Example, Artist, · 3:00" },
    reels_edits_audio_volume: { trackId: id, decibels: 0 },
    reels_edits_audio_segment: { trackId: id, inSeconds: 1 },
    reels_edits_export: { outputPath: "/abs/new.mp4" },
  };
  for (const [name, args] of Object.entries(examples)) {
    const result = (await service.request(name as keyof typeof editsTools, {
      ...(args as object),
      dryRun: true,
    })) as any;
    assert.equal(result.verified, false);
    assert.equal(result.attempted, false);
  }
  assert.deepEqual(
    calls,
    Object.keys(examples).map(() => "status"),
  );
});

test("permission errors are preserved; uncertain presses never replay or claim completion", async () => {
  const calls: string[] = [];
  const service = new EditsAutomation({
    invoke: async (op) => {
      calls.push(op);
      if (op === "tree") throw new Error("AX_PERMISSION_REQUIRED");
      return {
        verified: false,
        attempted: true,
        verification: { kind: "unknown" },
        fallback: null,
      };
    },
  });
  await assert.rejects(
    service.request("reels_edits_clip_list", {}),
    /AX_PERMISSION_REQUIRED/,
  );
  const result = (await service.request("reels_edits_ax_press", {
    target,
    intent: "editor-control",
    allowCoordinateFallback: true,
  })) as any;
  assert.equal(result.verified, false);
  assert.equal(result.fallback, null);
  assert.deepEqual(calls, ["tree", "press"]);
});

test("volume selects the exact clip and verifies readback; a no-op fails instead of passing", async () => {
  for (const apply of [true, false]) {
    let selected = false,
      volume = -70;
    const ops: EditsNativeOperation[] = [];
    const native = {
      invoke: async (
        op: EditsNativeOperation,
        args: Record<string, unknown>,
      ) => {
        ops.push(op);
        if (op === "tree")
          return snapshot([
            node({ identifier: id, selected }),
            node({
              role: "AXSlider",
              description: "Volume value",
              value: volume,
              settable: true,
            }),
          ]);
        if (op === "press") selected = true;
        if (op === "set-value" && apply) volume = Number(args.value);
        return { attempted: true, verified: apply };
      },
    };
    const service = new EditsAutomation(native, {
      timeoutMs: 5,
      pollMs: 1,
      project: async () => ({
        id,
        clips: [clip],
        source: "read-only Timeline.db",
      }),
    });
    const result = service.request("reels_edits_clip_mute", {
      clipId: id,
      muted: false,
    });
    if (apply) assert.equal(((await result) as any).verified, true);
    else await assert.rejects(result, /VERIFICATION_FAILED/);
    assert.equal(ops.filter((op) => op === "set-value").length, 1);
  }
});

test("ambiguous sibling targets and truncated trees fail before any mutation", async () => {
  for (const state of [
    snapshot([
      node({ identifier: id, target: { ...target, path: [0] } }),
      node({ identifier: id, target: { ...target, path: [1] } }),
    ]),
    { ...snapshot([]), truncated: true },
  ]) {
    const ops: string[] = [];
    const service = new EditsAutomation(
      {
        invoke: async (op) => {
          ops.push(op);
          return state;
        },
      },
      {
        project: async () => ({
          id,
          clips: [clip],
          source: "read-only Timeline.db",
        }),
      },
    );
    await assert.rejects(
      service.request("reels_edits_clip_mute", { clipId: id, muted: false }),
      /AMBIGUOUS|TRUNCATED/,
    );
    assert.ok(ops.every((op) => op === "tree"));
  }
});

test("busy writes are rejected instead of queued with stale context", async () => {
  let release!: (v: unknown) => void;
  const service = new EditsAutomation({
    invoke: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const first = service.request("reels_edits_status", {});
  await assert.rejects(service.request("reels_edits_status", {}), /EDITS_BUSY/);
  release({ trusted: false, screenLocked: "unknown" });
  await first;
});

test("dispatch validates and routes Edits only through the injected app port", async () => {
  const calls: unknown[] = [];
  const dispatch = createAgentDispatch({
    edits: {
      request: async (...args: unknown[]) => {
        calls.push(args);
        return { trusted: false };
      },
    },
  } as unknown as AgentPorts);
  assert.deepEqual(await dispatch("reels_edits_status", {}), {
    trusted: false,
  });
  await assert.rejects(dispatch("reels_edits_menu", { path: "File>Publish" }));
  assert.equal(calls.length, 1);
  const offline = createAgentDispatch({} as AgentPorts);
  await assert.rejects(offline("reels_edits_status", {}), /EDITS_UNAVAILABLE/);
});

test("known internal project schema is read-only, linked to visible clip IDs, and redacted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-project-test-"));
  try {
    const folder = path.join(root, "example.bsledits/Projects", id);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "Timeline.db"),
      db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE timelines(schema_version INTEGER,composition_data BLOB)",
    );
    const composition = {
      tracks: [
        {
          elements: [
            {
              id,
              content: {
                music: {
                  _0: {
                    title: "Example",
                    artistName: "Artist",
                    audioAssetId: "example-asset",
                    url: "must-not-leak",
                  },
                },
              },
              startTime: { value: 0, timescale: 1 },
              duration: { value: 300, timescale: 60 },
              inPoint: { value: 600, timescale: 60 },
              outPoint: { value: 900, timescale: 60 },
              fullDuration: { value: 1200, timescale: 60 },
              volume: 1,
            },
          ],
        },
      ],
    };
    db.prepare("INSERT INTO timelines VALUES (1,?)").run(
      Buffer.from(JSON.stringify(composition)),
    );
    db.close();
    const before = await readFile(file);
    const state = await readEditsProject(
      snapshot([node({ identifier: id })]),
      id,
      root,
    );
    assert.equal(state?.clips[0].sourceIn, 10);
    assert.equal(state?.clips[0].artist, "Artist");
    assert.doesNotMatch(JSON.stringify(state), /must-not-leak/);
    assert.deepEqual(await readFile(file), before);
    assert.equal(
      await readEditsProject(
        snapshot([node({ identifier: "not-a-clip" })]),
        id,
        root,
      ),
      null,
    );
    const duplicateFolder = path.join(
      root,
      "example.bsledits/Projects",
      "22222222-2222-4222-8222-222222222222",
    );
    await mkdir(duplicateFolder, { recursive: true });
    await writeFile(path.join(duplicateFolder, "Timeline.db"), before);
    await assert.rejects(
      readEditsProject(snapshot([node({ identifier: id })]), id, root),
      /PROJECT_AMBIGUOUS/,
    );
    assert.throws(
      () => decodeEditsComposition({ unknown: true }),
      /PROJECT_FORMAT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trim rejects expansion before mutation; metadata absence is explicit", async () => {
  const ops: string[] = [];
  const native = {
    invoke: async (op: EditsNativeOperation) => {
      ops.push(op);
      return snapshot([node({ identifier: id })]);
    },
  };
  const service = new EditsAutomation(native, {
    project: async () => ({
      id,
      clips: [clip],
      source: "read-only Timeline.db",
    }),
  });
  await assert.rejects(
    service.request("reels_edits_clip_trim", {
      clipId: id,
      inSeconds: 9,
      outSeconds: 15,
    }),
    /RANGE_EXPANSION/,
  );
  assert.deepEqual(ops, ["tree"]);
  const missing = new EditsAutomation(native, { project: async () => null });
  await assert.rejects(
    missing.request("reels_edits_audio_segment", { trackId: id, inSeconds: 2 }),
    /METADATA_UNAVAILABLE/,
  );
});

test("native child protocol validates IDs, errors and exit state without AX interaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-helper-test-"));
  try {
    const file = path.join(root, "helper");
    for (const body of [
      "JSON.stringify({protocol:1,id:r.id,ok:true,result:{parentPid:process.ppid}})",
      'JSON.stringify({protocol:1,id:r.id,ok:false,error:{code:"AX_PERMISSION_REQUIRED",message:"denied"}})',
      'JSON.stringify({protocol:1,id:r.id,ok:false,error:{code:"EDITS_HOST_UNSUPPORTED",message:"Run Edits tools through Reels Dashboard main",details:{reason:"unsupported-parent-launch"}}})',
      'JSON.stringify({protocol:1,id:"wrong",ok:true,result:{}})',
      '"not JSON"',
    ]) {
      await writeFile(
        file,
        `#!/usr/bin/env node\nlet b="";process.stdin.on("data",x=>b+=x);process.stdin.on("end",()=>{const r=JSON.parse(b);process.stdout.write(${body});});\n`,
      );
      await chmod(file, 0o755);
      const client = new EditsNativeClient(file, 2000);
      if (body.includes("parentPid"))
        assert.equal(
          (await client.invoke("status", {})).parentPid,
          process.pid,
        );
      else if (body.includes("EDITS_HOST_UNSUPPORTED"))
        await assert.rejects(client.invoke("status", {}), (error: any) => {
          assert.equal(error.code, "EDITS_HOST_UNSUPPORTED");
          assert.deepEqual(error.details, { reason: "unsupported-parent-launch" });
          return true;
        });
      else
        await assert.rejects(
          client.invoke("status", {}),
          /AX_PERMISSION_REQUIRED|HELPER_PROTOCOL/,
        );
      client.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("library add verifies the stored original version and never mutes source clips", async () => {
  const songId = "22222222-2222-4222-8222-222222222222";
  for (const correctVersion of [true, false]) {
    let added = false;
    let focused = false;
    const operations: {
      op: EditsNativeOperation;
      args: Record<string, unknown>;
    }[] = [];
    const label = "Example song, Example artist, · 3:00";
    const native = {
      invoke: async (
        op: EditsNativeOperation,
        args: Record<string, unknown>,
      ) => {
        operations.push({ op, args });
        if (op === "tree")
          return snapshot([
            node({ identifier: id }),
            node({ title: label, target: { ...target, path: [1] } }),
            node({ title: "add thin", target: { ...target, path: [2] } }),
            node({
              identifier: "editor.resolution",
              value: "4K/60",
              target: { ...target, path: [3] },
            }),
            node({
              identifier: "editor.timecode",
              description: "00:00.00 / 00:05.00",
              value: "00:00.00",
              focused,
              settable: true,
              actions: [{ name: "custom-edit", description: "Edit timecode" }],
              target: { ...target, path: [4] },
            }),
          ]);
        if (op === "press" && (args.target as typeof target).path[0] === 4)
          focused = true;
        if (op === "press" && (args.target as typeof target).path[0] === 2)
          added = true;
        if (op === "key") focused = false;
        return { attempted: true, verified: false, fallback: null };
      },
    };
    const service = new EditsAutomation(native, {
      project: async () => ({
        id,
        source: "read-only Timeline.db",
        clips: [
          clip,
          ...(added
            ? [
                {
                  ...clip,
                  id: songId,
                  kind: "music",
                  start: 0,
                  title: correctVersion
                    ? "Example song"
                    : "Example song (Cover)",
                  artist: "Example artist",
                  audioAssetId: "example-library-id",
                },
              ]
            : []),
        ],
      }),
    });
    const result = service.request("reels_edits_audio_add", {
      resultLabel: label,
    });
    if (correctVersion)
      assert.equal(
        ((await result) as any).added.audioAssetId,
        "example-library-id",
      );
    else await assert.rejects(result, /title\/artist mismatch/);
    assert.equal(
      operations.filter(
        (c) =>
          c.op === "press" && (c.args.target as typeof target).path[0] === 2,
      ).length,
      1,
    );
    assert.ok(
      operations
        .filter((c) => c.op === "set-value")
        .every((c) => c.args.intent === "timecode"),
    );
  }
});

test("slip must preserve timeline start and duration, and reports coordinate mode", async () => {
  for (const movedTimeline of [false, true]) {
    let dragged = false;
    const music = { ...clip, kind: "music", sourceIn: 10, sourceOut: 15 };
    const native = {
      invoke: async (op: EditsNativeOperation) => {
        if (op === "drag") dragged = true;
        return snapshot([
          node({
            identifier: id,
            selected: true,
            frame: { x: 100, y: 100, width: 250, height: 50 },
          }),
          node({
            identifier: "editor.tool.toolMode.trim",
            target: { ...target, path: [1] },
          }),
        ]);
      },
    };
    const service = new EditsAutomation(native, {
      project: async () => ({
        id,
        source: "read-only Timeline.db",
        clips: [
          {
            ...music,
            sourceIn: dragged ? 11 : 10,
            start: dragged && movedTimeline ? 1 : 0,
          },
        ],
      }),
    });
    const result = service.request("reels_edits_audio_segment", {
      trackId: id,
      inSeconds: 11,
    });
    if (movedTimeline)
      await assert.rejects(result, /slip source\/start\/duration/);
    else assert.equal(((await result) as any).fallback, "coordinate");
  }
});

test("export requires an observed success and a unique new file, copies exclusively", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-export-test-"));
  try {
    for (const ambiguous of [false, true]) {
      const exports = path.join(root, String(ambiguous));
      await mkdir(exports);
      const output = path.join(root, `output-${ambiguous}.mp4`);
      let exported = false;
      let presses = 0;
      const native = {
        invoke: async (op: EditsNativeOperation) => {
          if (op === "press") {
            presses++;
            exported = true;
            await writeFile(
              path.join(exports, "app-created.mp4"),
              "mock app export",
            );
            if (ambiguous)
              await writeFile(
                path.join(exports, "other-created.mp4"),
                "another export",
              );
          }
          return snapshot([
            node({ identifier: "editor.export" }),
            ...(exported
              ? [
                  node({
                    role: "AXStaticText",
                    title: "Your video has been exported successfully",
                  }),
                ]
              : []),
          ]);
        },
      };
      const service = new EditsAutomation(native, {
        exportRoot: exports,
        pollMs: 1,
      });
      const result = service.request("reels_edits_export", {
        outputPath: output,
      });
      if (ambiguous) {
        await assert.rejects(result, /FILE_AMBIGUOUS/);
        await assert.rejects(readFile(output));
      } else {
        assert.equal(((await result) as any).verified, true);
        assert.equal(await readFile(output, "utf8"), "mock app export");
        await assert.rejects(
          service.request("reels_edits_export", { outputPath: output }),
          /OUTPUT_EXISTS/,
        );
      }
      assert.equal(presses, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native JSON preserves a multibyte title split across stdout chunks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-utf8-test-"));
  try {
    const file = path.join(root, "helper");
    await writeFile(
      file,
      `#!/usr/bin/env node
let text="";
process.stdin.on("data",x=>text+=x);
process.stdin.on("end",()=>{
  const request=JSON.parse(text);
  const bytes=Buffer.from(JSON.stringify({protocol:1,id:request.id,ok:true,result:{title:"青のすみか"}}));
  const split=bytes.indexOf(Buffer.from("青"))+1;
  process.stdout.write(bytes.subarray(0,split));
  setTimeout(()=>process.stdout.end(bytes.subarray(split)),10);
});

`,
    );
    await chmod(file, 0o755);
    const client = new EditsNativeClient(file, 2000);
    try {
      assert.equal((await client.invoke("status", {})).title, "青のすみか");
    } finally {
      client.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only clip list reports incompleteness without enabling writes", async () => {
  const state = { ...snapshot([node({ identifier: id })]), truncated: true };
  const service = new EditsAutomation(
    { invoke: async () => state },
    { project: async () => null },
  );
  const result = (await service.request("reels_edits_clip_list", {})) as any;
  assert.equal(result.complete, false);
  assert.equal(result.verified, false);
  assert.equal(result.clips[0].id, id);
  await assert.rejects(
    service.request("reels_edits_clip_mute", { clipId: id }),
    /TRUNCATED/,
  );
});

test("audio search uses native placeholder matching and waits for fresh results", async () => {
  let changed = false,
    reads = 0;
  const field = node({
    role: "AXTextField",
    value: "old query",
    settable: true,
    target: { ...target, path: [1] },
  });
  const current = () =>
    snapshot([
      node({ title: "Audio" }),
      { ...field, value: changed ? "new query" : "old query" },
      node({
        title:
          changed && reads++ > 0
            ? "New song, Artist, · 3:00"
            : "Old song, Artist, · 2:00",
        target: { ...target, path: [2] },
      }),
    ]);
  const calls: string[] = [];
  const service = new EditsAutomation(
    {
      invoke: async (op, args) => {
        calls.push(op);
        if (op === "find") {
          assert.deepEqual(args.selector, {
            role: "AXTextField",
            label: "Search audio",
          });
          return { snapshot: current(), matches: [field] };
        }
        if (op === "set-value") changed = true;
        return current();
      },
    },
    { pollMs: 1, timeoutMs: 100 },
  );
  const result = (await service.request("reels_edits_audio_search", {
    query: "new query",
  })) as any;
  assert.equal(result.results[0].resultLabel, "New song, Artist, · 3:00");
  assert.equal(calls.filter((op) => op === "set-value").length, 1);
});
