import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildOpenCutProject,
  openCutRecipeSchema,
  travelCaptionTemplate,
} from "../../src/features/opencut-template";
import {
  prepareOpenCutPackage,
  openCutApplyScript,
} from "../../src/app/cli/opencut-package";
import { ContentLibrary } from "../../src/features/content-library";
import { LocalStore } from "../../src/shared/lib/storage";

const seed = () => ({
  version: 28,
  id: "editor-one",
  metadata: { name: "old place", duration: 0 },
  settings: {},
  currentSceneId: "scene",
  scenes: [
    {
      id: "scene",
      tracks: {
        main: {
          elements: [
            {
              type: "video",
              mediaId: "old",
              retime: { rate: 2 },
              effects: ["old"],
              transform: {},
            },
          ],
        },
        overlay: [
          {
            type: "video",
            elements: [{ type: "image", mediaId: "old-photo" }],
          },
          {
            type: "text",
            elements: [
              { type: "text", content: "old captions", animations: ["old"] },
            ],
          },
        ],
        audio: [{ old: true }],
      },
    },
  ],
});
const media = [
  { id: "new-video", name: "toast.mov", type: "video", duration: 8 },
  { id: "new-photo", name: "door.jpg", type: "image" },
];
const recipe = () =>
  openCutRecipeSchema.parse({
    templateId: "travel-caption-v1",
    title: "A night out",
    place: "New restaurant",
    cuts: [
      { file: "door.jpg", length: 2 },
      { file: "toast.mov", sourceIn: 1.4, length: 4, rate: 0.6 },
    ],
    captions: [
      { start: 0, end: 3, text: "New words" },
      { start: 3, end: 6, text: "Cheers" },
    ],
  });

test("retiming uses consumed source time and independent captions; replacement does not retain prior media/text/effects", () => {
  const before = seed();
  const p = buildOpenCutProject(before, media, recipe(), travelCaptionTemplate);
  const t = p.scenes[0].tracks;
  assert.equal(t.main.elements[1].duration, 4 * 120000);
  assert.equal(t.main.elements[1].trimStart, 1.4 * 120000);
  assert.equal(
    t.main.elements[1].trimEnd,
    Math.round((8 - 1.4 - 2.4) * 120000),
  );
  assert.equal(t.main.elements[1].retime.rate, 0.6);
  assert.equal(t.main.elements[1].mediaId, "new-video");
  assert.equal(t.main.elements[1].effects, undefined);
  assert.deepEqual(t.audio, []);
  assert.equal(t.overlay[2].elements[0].duration, 3 * 120000);
  assert.equal(p.metadata.duration, 6 * 120000);
  assert.equal(p.settings.canvasSize.width, 1080);
  assert.equal(before.scenes[0].tracks.main.elements[0].mediaId, "old");
  const second = recipe();
  second.place = "Another place";
  second.captions = [{ start: 0, end: 6, text: "Different visit" }];
  const next = buildOpenCutProject(
    p,
    media.map((m) => ({ ...m, id: m.id + "-second" })),
    second,
    travelCaptionTemplate,
  );
  assert.equal(
    next.scenes[0].tracks.main.elements[1].mediaId,
    "new-video-second",
  );
  assert.equal(next.scenes[0].tracks.overlay[2].elements.length, 1);
  assert.equal(JSON.stringify(next).includes("New words"), false);
});

test("browser builder is standalone and package script is executable JavaScript", () => {
  const standalone = new Function(
    `return (${buildOpenCutProject.toString()})`,
  )();
  assert.equal(
    standalone(seed(), media, recipe(), travelCaptionTemplate).metadata
      .duration,
    720000,
  );
  assert.equal(
    typeof new Function(`return (${openCutApplyScript(recipe())})`)(),
    "function",
  );
});

test("schema, missing/duplicate media, long stills and out-of-source slow motion fail before touching seed", () => {
  assert.throws(
    () =>
      buildOpenCutProject(
        { ...seed(), version: 29 },
        media,
        recipe(),
        travelCaptionTemplate,
      ),
    /schema/,
  );
  assert.throws(
    () => buildOpenCutProject(seed(), [], recipe(), travelCaptionTemplate),
    /Missing/,
  );
  assert.throws(
    () =>
      buildOpenCutProject(
        seed(),
        [...media, media[0]],
        recipe(),
        travelCaptionTemplate,
      ),
    /duplicate/,
  );
  const still = recipe();
  still.cuts[0].length = 4;
  assert.throws(
    () => buildOpenCutProject(seed(), media, still, travelCaptionTemplate),
    /Still image/,
  );
  const over = recipe();
  over.cuts[1].sourceIn = 7;
  assert.throws(
    () => buildOpenCutProject(seed(), media, over, travelCaptionTemplate),
    /exceeds/,
  );
  const bad = recipe();
  bad.captions[1].start = 2;
  assert.equal(openCutRecipeSchema.safeParse(bad).success, false);
});

test("package uses registered blog/media, keeps existing project resources and rejects overwrite or missing grants", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "opencut-package-")),
  );
  try {
    const data = path.join(root, "data"),
      sources = path.join(root, "sources");
    await mkdir(sources);
    const video = path.join(sources, "toast.mov"),
      photo = path.join(sources, "door.jpg"),
      blog = path.join(sources, "article.md");
    await Promise.all([
      writeFile(video, "synthetic-video"),
      writeFile(photo, "synthetic-photo"),
      writeFile(blog, "# A visit\nUser experience"),
    ]);
    const store = new LocalStore(data);
    await store.initialize();
    const library = new ContentLibrary(store);
    await library.upsert(
      {
        id: "sample",
        title: "Existing card",
        date: "2026-11-12",
        dateBasis: "capture",
        stage: "review",
        nextAction: "Keep this",
        publicURL: "",
        localNotes: "Keep notes",
        publications: [{ channel: "blog", status: "planned", url: "" }],
        resources: [{ role: "folder", path: sources, label: "source folder" }],
      },
      (await store.load()).updatedAt,
    );
    const calls: string[] = [];
    const call = async (name: string, args: any) => {
      calls.push(name);
      if (name === "reels_get_content") return library.get(args.projectId);
      if (name === "reels_upsert_content")
        return library.upsert(args.content, args.expectedUpdatedAt);
      throw Error(name);
    };
    const input = {
      projectId: "sample",
      blogPath: blog,
      destination: path.join(root, "package"),
      sources: [video, photo],
      recipe: recipe(),
    };
    const result = await prepareOpenCutPackage(input, data, call);
    assert.equal(result.registered, true);
    assert.equal(
      await readFile(path.join(result.directory, "toast.mov"), "utf8"),
      "synthetic-video",
    );
    assert.equal(await readFile(video, "utf8"), "synthetic-video");
    assert.match(
      await readFile(path.join(result.directory, "captions.srt"), "utf8"),
      /00:00:03,000 --> 00:00:06,000/,
    );
    const current = (await library.get("sample")).project;
    assert.equal(current.nextAction, "Keep this");
    assert.equal(current.resources?.length, 4);
    assert.equal(current.publications?.[0].channel, "blog");
    assert.equal(current.production, undefined);
    assert.ok(calls.includes("reels_upsert_content"));
    await assert.rejects(
      prepareOpenCutPackage(input, data, call),
      /already exists/,
    );
    const other = path.join(root, "other.mov");
    await writeFile(other, "not registered");
    await assert.rejects(
      prepareOpenCutPackage(
        {
          ...input,
          destination: path.join(root, "bad"),
          sources: [video, photo, other],
        },
        data,
        call,
      ),
      /등록한 자료/,
    );
    await assert.rejects(access(path.join(root, "bad")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
