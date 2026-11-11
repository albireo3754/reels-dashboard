import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analyzeEvidence,
  prepareEvidence,
  renderEvidenceMetadataTable,
  type EvidenceManifest,
} from "../../src/desktop/media-evidence";
import type { ImageAnalyzer } from "../../src/desktop/analysis-provider";

const fields = {
  description: "Synthetic fixture",
  tags: [],
  ocr: [],
  uncertainties: [],
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "media-evidence-test-"));
  const files = [path.join(root, "one.jpg"), path.join(root, "two.jpg")];
  await Promise.all(
    files.map((file, index) => writeFile(file, `fixture ${index}`)),
  );
  const manifest: EvidenceManifest = {
    version: 1,
    projectId: "fixture",
    title: "All captures",
    request: "Inspect every image",
    context: {
      venue: "Known venue",
      location: "",
      visit: "",
      menus: "",
      surroundings: "",
      notes: "",
      sources: [],
    },
    captures: files.map((sourcePath, index) => ({
      id: `capture-${index}`,
      sourcePath,
    })),
    images: files.map((file, index) => ({
      id: `image-${index}`,
      captureId: `capture-${index}`,
      path: file,
      kind: "photo",
      time: null,
    })),
  };
  const output = path.join(root, "out");
  return { root, files, manifest, output };
}
function fake(received: string[][]): ImageAnalyzer {
  return {
    id: "fake",
    label: "fake",
    async analyze(samples) {
      received.push(samples.map((sample) => sample.id));
      return samples.map(() => fields);
    },
  };
}

test("every manifest image is analyzed, including a capture not chosen for editing; successful batches resume", async () => {
  const f = await fixture();
  try {
    const received: string[][] = [];
    const first = await analyzeEvidence(f.manifest, f.output, fake(received), {
      batchSize: 1,
    });
    assert.equal(first.analysisComplete, true);
    assert.deepEqual(received.flat().sort(), ["image-0", "image-1"]);
    assert.equal(first.resolvedCaptures, 2);
    const second = await analyzeEvidence(f.manifest, f.output, fake(received), {
      batchSize: 1,
    });
    assert.equal(second.analysisComplete, true);
    assert.equal(received.length, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing capture coverage, unknown capture, duplicate IDs and missing files reject before provider execution", async () => {
  const f = await fixture();
  try {
    const received: string[][] = [];
    for (const manifest of [
      { ...f.manifest, images: [f.manifest.images[0]] },
      { ...f.manifest, images: [...f.manifest.images, f.manifest.images[0]] },
      {
        ...f.manifest,
        captures: [...f.manifest.captures, f.manifest.captures[0]],
      },
      {
        ...f.manifest,
        images: f.manifest.images.map((image) => ({
          ...image,
          captureId: "unknown",
        })),
      },
      {
        ...f.manifest,
        images: f.manifest.images.map((image) => ({
          ...image,
          path: path.join(f.root, "absent"),
        })),
      },
    ])
      await assert.rejects(analyzeEvidence(manifest, f.output, fake(received)));
    assert.equal(received.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed batch cannot pass coverage and successful batch is reusable on explicit restart", async () => {
  const f = await fixture();
  try {
    const analyzer: ImageAnalyzer = {
      id: "fake",
      label: "fake",
      async analyze(samples) {
        if (samples[0].id === "image-1")
          throw new Error("private provider stderr");
        return samples.map(() => fields);
      },
    };
    const result = await analyzeEvidence(f.manifest, f.output, analyzer, {
      batchSize: 1,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.analysisComplete, false);
    assert.equal(result.resolved, 1);
    assert.equal(result.failed.length, 1);
    const report = await readFile(path.join(f.output, "coverage.json"), "utf8");
    assert.ok(!report.includes("private provider stderr"));
    const received: string[][] = [];
    const resumed = await analyzeEvidence(
      f.manifest,
      f.output,
      fake(received),
      { batchSize: 1 },
    );
    assert.equal(resumed.analysisComplete, true);
    assert.deepEqual(received, [["image-1"]]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("context, request and image changes invalidate output reuse", async () => {
  const f = await fixture();
  try {
    const received: string[][] = [];
    await analyzeEvidence(f.manifest, f.output, fake(received));
    await assert.rejects(
      analyzeEvidence(
        {
          ...f.manifest,
          context: { ...f.manifest.context, notes: "User correction" },
        },
        f.output,
        fake(received),
      ),
      /fingerprint changed/,
    );
    await assert.rejects(
      analyzeEvidence(
        { ...f.manifest, request: "New request" },
        f.output,
        fake(received),
      ),
      /fingerprint changed/,
    );
    await writeFile(f.files[0], "modified");
    await assert.rejects(
      analyzeEvidence(f.manifest, f.output, fake(received)),
      /fingerprint changed/,
    );
    assert.equal(received.length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("byte-identical images retain distinct source IDs, filenames and timestamps", async () => {
  const f = await fixture();
  try {
    await writeFile(f.files[1], await readFile(f.files[0]));
    f.manifest.images[1].kind = "video-frame";
    f.manifest.images[1].time = 4.5;
    const prepared = await prepareEvidence(f.manifest);
    assert.equal(prepared.images[0].sha256, prepared.images[1].sha256);
    const received: string[][] = [];
    await analyzeEvidence(f.manifest, f.output, fake(received));
    const saved = JSON.parse(
      await readFile(path.join(f.output, "results.json"), "utf8"),
    );
    assert.deepEqual(
      saved.images.map((image: any) => [
        image.id,
        image.captureId,
        image.sourcePath,
        image.time,
      ]),
      [
        ["image-0", "capture-0", f.files[0], null],
        ["image-1", "capture-1", f.files[1], 4.5],
      ],
    );
    assert.deepEqual(received, [["image-0", "image-1"]]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("check-only validates all inputs without model calls or completed-analysis claims", async () => {
  const f = await fixture();
  try {
    const received: string[][] = [];
    const result = await analyzeEvidence(f.manifest, f.output, fake(received), {
      checkOnly: true,
    });
    assert.equal(result.status, "checked");
    assert.equal(result.analysisComplete, false);
    assert.equal(result.resolved, 2);
    assert.equal(received.length, 0);
    const analyzed = await analyzeEvidence(
      f.manifest,
      f.output,
      fake(received),
    );
    assert.equal(analyzed.analysisComplete, true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("image changes while provider runs prevent completion", async () => {
  const f = await fixture();
  try {
    const analyzer: ImageAnalyzer = {
      id: "fake",
      label: "fake",
      async analyze(samples) {
        await writeFile(f.files[0], "changed while analyzing");
        return samples.map(() => fields);
      },
    };
    const result = await analyzeEvidence(f.manifest, f.output, analyzer);
    assert.equal(result.analysisComplete, false);
    assert.ok(result.inputChanged.includes("image-0"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("provider context contains only its batch image sources and retains shared context", async () => {
  const f = await fixture();
  try {
    const contexts: { sampleIds: string[]; context: any }[] = [];
    const analyzer: ImageAnalyzer = {
      id: "fake",
      label: "fake",
      async analyze(samples, context) {
        contexts.push({
          sampleIds: samples.map((sample) => sample.id),
          context: JSON.parse(context),
        });
        return samples.map(() => fields);
      },
    };
    const result = await analyzeEvidence(f.manifest, f.output, analyzer, {
      batchSize: 1,
    });
    assert.equal(result.analysisComplete, true);
    assert.equal(contexts.length, 2);
    for (const { sampleIds, context } of contexts) {
      assert.deepEqual(
        context.imageSources.map((image: any) => image.id),
        sampleIds,
      );
      assert.deepEqual(context.context, f.manifest.context);
      assert.equal(context.projectId, f.manifest.projectId);
      const otherId = f.manifest.images.find(
        (image) => !sampleIds.includes(image.id),
      )!.id;
      assert.ok(!JSON.stringify(context).includes(otherId));
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("metadata table preserves all IDs, failures, fields, sources and timestamps without broken rows", () => {
  const tricky = "a|b\n<c>&";
  const imagePath = "/private/example image|name.jpg";
  const sourcePath = "/private/original (one).mov";
  const regions = [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }];
  const table = renderEvidenceMetadataTable(
    {
      images: [
        {
          id: "image-0",
          captureId: "capture-0",
          sourcePath,
          path: imagePath,
          kind: "video-frame",
          time: 4.5,
          status: "resolved",
          sha256: "sha-example",
          sourceLabel: `source ${tricky}`,
          fields: {
            description: `description ${tricky}`,
            tags: [`tag ${tricky}`],
            ocr: [`ocr ${tricky}`],
            contextNotes: [`context ${tricky}`],
            uncertainties: [`uncertain ${tricky}`],
            faceRegions: regions,
          },
        },
        {
          id: "image-1",
          captureId: "capture-1",
          sourcePath: "/private/photo.jpg",
          path: "/private/frame.jpg",
          kind: "photo",
          time: null,
          status: "failed",
        },
      ],
    },
    "/private/result folder/results.json",
  );
  const rows = table.split("\n").filter((line) => line.startsWith("| image-"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("| image-0 | resolved |"));
  assert.ok(rows[1].includes("| image-1 | failed |"));
  assert.ok(rows[1].includes("미분석"));
  assert.ok(table.includes("전체 입력 2행 · 실패 1행"));
  assert.ok(table.includes("/private/result%20folder/results.json"));
  assert.ok(rows[0].includes("capture-0"));
  assert.ok(rows[0].includes(sourcePath));
  assert.ok(rows[0].includes("video-frame<br>4.5"));
  assert.ok(rows[0].includes("/private/example%20image%7Cname.jpg"));
  assert.ok(rows[0].includes("sha-example"));
  assert.ok(
    rows[0].includes(
      JSON.stringify(regions).replace(/\[/g, "\\[").replace(/\]/g, "\\]"),
    ),
  );
  for (const label of [
    "description",
    "tag",
    "ocr",
    "context",
    "uncertain",
    "source",
  ])
    assert.ok(rows[0].includes(`${label} a&#124;b<br>&lt;c&gt;&amp;`));
  // Thirteen cells plus opening/closing delimiters: embedded pipes did not create extra columns.
  for (const row of rows) assert.equal(row.split("|").length, 15);
  assert.ok(!table.includes("<c>"));
});

test("analysis emits a complete metadata table even when a batch fails", async () => {
  const f = await fixture();
  try {
    const analyzer: ImageAnalyzer = {
      id: "fake",
      label: "fake",
      async analyze(samples) {
        if (samples[0].id === "image-1") throw new Error("Fixture failure");
        return samples.map(() => fields);
      },
    };
    await analyzeEvidence(f.manifest, f.output, analyzer, { batchSize: 1 });
    const table = await readFile(
      path.join(f.output, "metadata-table.md"),
      "utf8",
    );
    assert.equal(
      table.split("\n").filter((line) => line.startsWith("| image-")).length,
      f.manifest.images.length,
    );
    assert.ok(table.includes("| image-1 | failed |"));
    assert.ok(table.includes("전체 입력 2행 · 실패 1행"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
