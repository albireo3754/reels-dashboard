import { ExecutionLogs } from "../../src/shared/lib/execution-logs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "../../src/shared/lib/storage";
import { ContentLibrary } from "../../src/features/content-library";
import { MediaAnalysis } from "../../src/desktop/media-analysis";
const fields = {
  description: "잔이 나란히 있어요.",
  tags: ["맥주"],
  ocr: [],
  uncertainties: ["건배 동작은 확인할 수 없어요."],
  contextNotes: ["메뉴 기록의 소금바베큐는 화면에 없어서 태그로 적용하지 않았어요."],
};
test("project isolation, stale corrections and reanalysis preserve human edits", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "analysis-test-")),
  );
  try {
    const media = path.join(root, "media");
    await mkdir(media);
    await writeFile(path.join(media, "photo.jpg"), "fixture");
    const store = new LocalStore(root);
    await store.initialize();
    await store.update((d) => ({
      ...d,
      projects: ["one", "two"].map((id) => ({
        id,
        title: id,
        date: "2026-10-31",
        stage: "captured" as const,
        nextAction: "",
        publicURL: "",
        shared: false,
        resources: [{ role: "folder" as const, path: media, label: "sources" }],
      })),
    }));
    const received: string[] = [];
    const service = new MediaAnalysis(
      store,
      new ContentLibrary(store),
      "unused",
      new ExecutionLogs(root),
      [
        {
          id: "fake",
          label: "fake",
          async analyze(samples, context) {
            received.push(context);
            return samples.map(() => fields);
          },
        },
      ],
    );
    // Replace media extraction only; run batching, persistence and provider invocation remain real.
    (service as any).prepare = async (_id: string, sourcePath: string) => {
      const { stat } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const s = await stat(sourcePath);
      return [
        {
          id: "sample",
          sourcePath,
          sourceVersion: createHash("sha256")
            .update(`${s.size}:${s.mtimeMs}`)
            .digest("hex"),
          kind: "photo",
          time: null,
          imagePath: sourcePath,
        },
      ];
    };
    const finish = async () => {
      for (let i = 0; i < 100; i++) {
        const d = await service.search({ projectId: "one" });
        if (d.runs.at(-1)?.status === "completed") return d;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("timed out");
    };
    await assert.rejects(
      service.start({ projectId: "one", folder: media, provider: "absent" }),
    );
    await assert.rejects(
      service.start({ projectId: "one", folder: root, provider: "fake" }),
    );
    await assert.rejects(
      service.start({
        projectId: "one",
        folder: media,
        provider: "fake",
        context: { menus: "확인한 소금바베큐" },
      }),
      /CONTEXT_REVISION_REQUIRED/,
    );
    await service.start({
      projectId: "one",
      folder: media,
      provider: "fake",
      context: {
        venue: "테스트 식당",
        menus: "확인한 소금바베큐",
        visit: "2026-09-23 촬영, 게시일과 다름",
        sources: ["synthetic confirmed note"],
      },
      expectedRevision: 0,
    });
    let d = await finish();
    assert.equal(d.matches.length, 1);
    assert.equal((await service.search({projectId:"one",query:"소금바베큐"})).matches.length,0);
    assert.equal(d.context?.menus, "확인한 소금바베큐");
    assert.equal(d.runs[0].context?.venue, "테스트 식당");
    assert.equal(d.runs[0].promptVersion, "context-v4-selection-mcp");
    assert.equal(JSON.parse(received[0]).facts.menus, "확인한 소금바베큐");
    assert.equal(JSON.parse(received[0]).dateBasis, "unknown");
    await assert.rejects(
      service.start({
        projectId: "one",
        folder: media,
        provider: "fake",
        context: { menus: "덮어쓰기" },
        expectedRevision: 0,
      }),
      /STALE_ANALYSIS/,
    );
    assert.equal(
      (await service.search({ projectId: "two" })).context,
      undefined,
    );
    assert.equal(
      (await service.search({ projectId: "two" })).matches.length,
      0,
    );
    await service.correct({
      projectId: "one",
      sampleId: "sample",
      expectedRevision: d.revision,
      fields: { description: "내가 고친 설명" },
    });
    await assert.rejects(
      service.correct({
        projectId: "one",
        sampleId: "sample",
        expectedRevision: d.revision,
        fields: { description: "stale" },
      }),
      /STALE/,
    );
    await service.start({ projectId: "one", folder: media, provider: "fake" });
    d = await finish();
    assert.equal(d.results.length, 1);
    assert.equal(received.length, 1);
    assert.equal(d.runs[1].skippedSamples, 1);
    assert.equal(d.runs[1].analyzedSamples, 0);
    assert.equal(d.runs[1].context?.menus, d.runs[0].context?.menus);
    assert.equal(d.matches[0].effective.description, "내가 고친 설명");
    assert.equal(d.matches[0].fields.description, fields.description);
    await service.start({ projectId: "one", folder: media, provider: "fake", force: true });
    d = await finish();
    assert.equal(received.length, 2);
    assert.equal(d.results.length, 2);
    assert.equal(d.matches[0].effective.description, "내가 고친 설명");
    await service.start({ projectId: "one", folder: media, provider: "fake", model: "different-model" });
    d = await finish();
    assert.equal(received.length, 3);
    assert.equal(d.runs.at(-1)?.requestedModel, "different-model");

    assert.equal(
      (await service.search({ projectId: "one", query: "고친" })).matches
        .length,
      1,
    );
    const { rename } = await import("node:fs/promises");
    await rename(path.join(media, "photo.jpg"), path.join(media, "renamed.jpg"));
    await service.start({ projectId: "one", folder: media, provider: "fake" });
    d = await finish();
    assert.equal(received.length, 3);
    assert.equal(d.matches[0].sample.sourcePath, path.join(media, "renamed.jpg"));
    for (const name of ["second.jpg", "third.jpg", "fourth.jpg"])
      await writeFile(path.join(media, name), "fixture");
    let calls = 0;
    const failing = new MediaAnalysis(
      store,
      new ContentLibrary(store),
      "unused",
      new ExecutionLogs(root),
      [
        {
          id: "broken",
          label: "broken",
          async analyze() {
            calls++;
            throw new Error("provider unavailable");
          },
        },
      ],
    );
    (failing as any).prepare = (service as any).prepare;
    await failing.start({
      projectId: "one",
      folder: media,
      provider: "broken",
    });
    let failed;
    for (let i = 0; i < 100; i++) {
      failed = (await failing.search({ projectId: "one" })).runs.at(-1);
      if (failed?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.processedFiles, 3);
    assert.equal(failed?.totalFiles, 4);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("noninteractive subprocess receives EOF instead of hanging on piped stdin", async () => {
  const { runFile } = await import("../../src/desktop/analysis-provider");
  const { stdout } = await runFile(
    process.execPath,
    [
      "-e",
      "let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>process.stdout.write('EOF:'+input))",
    ],
    { timeout: 2000 },
  );
  assert.equal(stdout, "EOF:");
});

test("usage preserves missing counters and sums only observed turns", async () => {
  const { parseAnalysisUsage } = await import("../../src/desktop/analysis-provider");
  assert.deepEqual(parseAnalysisUsage([], 12, 3), { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, actualModel: null, actualReasoning: null, durationMs: 12, imageCount: 3 });
  const usage = parseAnalysisUsage([{ type: "turn.started", model: "observed", reasoning_effort: "high" }, { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 7 } }, { type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 3 } }], 24, 2);
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.cachedInputTokens, 3);
  assert.equal(usage.outputTokens, 10);
  assert.equal(usage.reasoningTokens, null);
  assert.equal(usage.actualModel, "observed");
});


test("content identity survives copy/mtime changes and detects same-size edits", async () => {
  const { analysisContentDigest } = await import("../../src/desktop/media-analysis");
  const { copyFile, utimes } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "analysis-hash-"));
  try {
    const first = path.join(dir, "one.jpg"), copy = path.join(dir, "copy.jpg");
    await writeFile(first, "synthetic-a");
    await copyFile(first, copy);
    await utimes(copy, 0, 0);
    assert.equal(await analysisContentDigest(first), await analysisContentDigest(copy));
    await writeFile(copy, "synthetic-b");
    assert.notEqual(await analysisContentDigest(first), await analysisContentDigest(copy));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("usage-less completed turns make aggregate counters unknown", async () => {
  const { parseAnalysisUsage } = await import("../../src/desktop/analysis-provider");
  const usage = parseAnalysisUsage([{ type: "turn.completed", usage: { input_tokens: 8 } }, { type: "turn.completed" }], 1, 1);
  assert.equal(usage.inputTokens, null);
});

test("metadata cache skips original digest and extraction across service restarts", async () => {
  const { chmod, utimes } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "analysis-cache-")));
  try {
    const media = path.join(root, "media"), bin = path.join(root, "bin");
    await mkdir(media); await mkdir(bin);
    const source = path.join(media, "photo.jpg");
    await writeFile(source, "synthetic");
    // The fake extractor records invocations and creates its last output argument.
    const marker = path.join(root, "extract-count");
    const ffmpeg = path.join(bin, "ffmpeg");
    await writeFile(ffmpeg, `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');fs.writeFileSync(process.argv.at(-1),'jpeg');`);
    await chmod(ffmpeg, 0o755);
    const store = new LocalStore(root); await store.initialize();
    await store.update(d => ({ ...d, projects: [{ id: "cache", title: "cache", date: "2026-11-14", stage: "captured", nextAction: "", publicURL: "", shared: false, resources: [{ role: "folder", path: media, label: "synthetic" }] }] }));
    let calls = 0;
    const make = () => new MediaAnalysis(store, new ContentLibrary(store), root, new ExecutionLogs(root), [{ id: "fake", label: "fake", async analyze(samples) { calls++; return samples.map(() => fields); } }]);
    const run = async (service: MediaAnalysis) => {
      await service.start({projectId:"cache", folder:media, provider:"fake"});
      for(let i=0;i<500;i++) { const view=await service.search({projectId:"cache"}); if(view.runs.at(-1)?.finishedAt) { assert.equal(view.runs.at(-1)?.status,"completed"); await new Promise(r=>setTimeout(r,20)); return view; } await new Promise(r=>setTimeout(r,10)); }
      throw Error("timeout");
    };
    await run(make());
    // Removing the extractor and forbidding digest reads proves the warm path does not need them.
    await rm(ffmpeg);
    const warmService = make();
    (warmService as any).contentDigest = () => { throw Error("original read forbidden"); };
    const warm = await run(warmService);
    assert.equal(warm.runs.at(-1)?.skippedSamples,1); assert.equal(calls,1);
    const {readFile}=await import("node:fs/promises"); assert.equal(await readFile(marker,"utf8"),"x");

    // Recreate the synthetic extractor; metadata changes must invalidate the cached digest.
    await writeFile(ffmpeg, `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');fs.writeFileSync(process.argv.at(-1),'jpeg');`); await chmod(ffmpeg,0o755);
    await utimes(source,1,1); await run(make());
    assert.equal(await readFile(marker,"utf8"),"xx"); assert.equal(calls,1);
    await writeFile(source,"synthetic changed size"); await run(make());
    assert.equal(calls,2); assert.equal(await readFile(marker,"utf8"),"xxx");
  } finally { await rm(root,{recursive:true,force:true}); }
});
