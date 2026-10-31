import test from "node:test";
import assert from "node:assert/strict";
import {
  newCardPlan,
  timeline,
  recommendTiming,
  recommendedSeconds,
  musicError,
} from "../../src/shared/card-news-model";
import { cardPlanSchema } from "../../src/shared/card-news";
import { CardNewsService } from "../../src/desktop/card-news";
import { LocalStore } from "../../src/shared/lib/storage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("reading recommendations protect dense comparisons and retain content", () => {
  const plan = newCardPlan();
  assert.equal(timeline(plan.cards).at(-1)!.end, 24);
  plan.cards[3].text = "정보가많은비교표".repeat(14);
  plan.cards[0].imageId = crypto.randomUUID();
  plan.music.bpm = 113;
  const next = recommendTiming(plan, true);
  next.cards.forEach((c, i) => {
    assert.ok(c.seconds >= recommendedSeconds(plan.cards[i]));
    assert.equal(c.text, plan.cards[i].text);
    assert.equal(c.imageId, plan.cards[i].imageId);
  });
  const segments = timeline(next.cards);
  segments.forEach((s, i) => {
    if (i) assert.equal(s.start, segments[i - 1].end);
    assert.equal(s.frames, Math.round(next.cards[i].seconds * 30));
  });
  assert.throws(() =>
    cardPlanSchema.parse({ ...plan, cards: [plan.cards[0], plan.cards[0]] }),
  );
  assert.throws(() =>
    cardPlanSchema.parse({ ...plan, music: { ...plan.music, bpm: NaN } }),
  );
});
test("music offsets must fit unless repeat is deliberately enabled", () => {
  const plan = newCardPlan();
  plan.music.assetId = crypto.randomUUID();
  plan.music.offset = 5;
  assert.equal(musicError(plan, 30), null);
  assert.match(musicError(plan, 10)!, /짧아요/);
  plan.music.loop = true;
  assert.equal(musicError(plan, 10), null);
  assert.match(musicError(plan, 4)!, /벗어났어요/);
});
test("saved plans survive restart, reject stale writes and ungranted assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "card-news-test-"));
  try {
    const store = new LocalStore(root);
    await store.initialize();
    const options = {
      root,
      store,
      runtime: root,
      chooseAsset: async () => null,
      chooseOutput: async () => null,
      normalizeImage: (b: Buffer) => b,
      validateFrame: () => {},
      reveal: () => {},
      changed: () => {},
    };
    const service = new CardNewsService(options);
    const original = newCardPlan();
    original.cards[0].text = "저장한 첫 문장";
    const saved = await service.save(original);
    const second = new CardNewsService(options);
    assert.deepEqual((await second.load(saved.id)).plan, saved);
    await assert.rejects(
      service.save({ ...original, title: "오래된 수정" }),
      /다른 창/,
    );
    await assert.rejects(
      service.save({
        ...saved,
        cards: saved.cards.map((c) => ({ ...c, imageId: crypto.randomUUID() })),
      }),
    );
    assert.equal((await second.list())[0].title, saved.title);
    await assert.rejects(second.load("../../outside"), /ID/);
    assert.deepEqual((await store.load()).projects, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("video source ranges reject overrun and non-finite offsets", async () => {
  const { videoError } = await import("../../src/shared/card-news-model");
  const p = newCardPlan();
  p.cards[0].seconds = 2;
  p.cards[0].videoStart = 1;
  assert.equal(videoError(p.cards[0], 3), null);
  assert.match(videoError(p.cards[0], 2.9)!, /벗어나/);
  assert.throws(() =>
    cardPlanSchema.parse({ ...p, cards: [{ ...p.cards[0], videoStart: -1 }] }),
  );
  assert.throws(() =>
    cardPlanSchema.parse({
      ...p,
      cards: [{ ...p.cards[0], videoStart: Infinity }],
    }),
  );
});

test("template inputs reject per-line typography and custom PNG bypasses", async () => {
  const { templateContent } = await import("../../src/shared/card-news");
  const plan = newCardPlan();
  assert.throws(() =>
    cardPlanSchema.parse({
      ...plan,
      cards: [{ ...plan.cards[0], lineSizes: [70, 90] }],
    }),
  );
  assert.throws(() =>
    cardPlanSchema.parse({ ...plan, style: { ...plan.style, fontSize: 90 } }),
  );
  assert.throws(() => templateContent({ ...plan.cards[0], imageOnly: true }));
  assert.throws(() =>
    templateContent({ ...plan.cards[0], overlayId: crypto.randomUUID() }),
  );
  assert.throws(() =>
    templateContent({ ...plan.cards[0], templateId: "comparison" }),
  );
  assert.equal(templateContent(plan.cards[0]).templateId, "hook");
});
