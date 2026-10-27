import test from "node:test";
import assert from "node:assert/strict";
import { defaultEditSettings } from "../../src/shared/editor";
import { validateEditSettings } from "../../src/shared/editor-model";
import { parseRange } from "../../src/desktop/editor";
const settings = () => {
  const s = defaultEditSettings(10);
  s.place.name = "서울";
  s.place.description = "산책하기 좋은 길";
  s.cover.hook = "산책하기 좋은\n서울의 골목";
  return s;
};
test("editor separates draft saving, video preview and cover requirements", () => {
  const s = settings();
  s.cover.hook = "";
  assert.doesNotThrow(() => validateEditSettings(s, 10, "video"));
  assert.throws(() => validateEditSettings(s, 10, "export"), /두 줄/);
  assert.doesNotThrow(() =>
    validateEditSettings(defaultEditSettings(10), 10, "draft"),
  );
});
test("caption intervals are half-open, ordered and within source duration", () => {
  const s = settings();
  s.captions.items = [
    { id: "a", start: 0, end: 3, text: "먼저 걸어봤어요." },
    { id: "b", start: 3, end: 5, text: "풍경이 보여요." },
  ];
  assert.doesNotThrow(() => validateEditSettings(s, 10, "export"));
  s.captions.items[1].start = 2;
  assert.throws(() => validateEditSettings(s, 10, "video"), /겹치지/);
  s.captions.items[1].start = 3;
  s.captions.items[1].end = 11;
  assert.throws(() => validateEditSettings(s, 10, "video"));
});
test("editor rejects unsupported templates and non-finite positions without changing templates", () => {
  const s = settings();
  s.place.x = NaN;
  assert.throws(() => validateEditSettings(s, 10, "video"));
  s.place.x = 0.5;
  (s.place as any).material = "shell";
  assert.throws(() => validateEditSettings(s, 10));
  const clean = validateEditSettings(settings(), 10, "export");
  assert.equal(clean.place.useDefaultPosition, true);
  assert.equal(clean.cover.useDefaultPosition, true);
});
test("video streaming ranges support seek, suffix and bounded ends", () => {
  assert.deepEqual(parseRange("bytes=10-20", 100), {
    start: 10,
    end: 20,
    partial: true,
  });
  assert.deepEqual(parseRange("bytes=-8", 100), {
    start: 92,
    end: 99,
    partial: true,
  });
  assert.deepEqual(parseRange("bytes=50-", 100), {
    start: 50,
    end: 99,
    partial: true,
  });
  assert.deepEqual(parseRange("bytes=50-200", 100), {
    start: 50,
    end: 99,
    partial: true,
  });
  for (const value of [
    "bytes=100-",
    "bytes=20-10",
    "bytes=0-1,8-9",
    "bytes=-0",
    "bytes=--",
  ])
    assert.throws(() => parseRange(value, 100));
});
