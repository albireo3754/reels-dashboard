import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDashboard,
  toSnapshot,
  fromSnapshot,
} from "../../src/shared/data";
import type { Dashboard } from "../../src/shared/contracts";
const sample = (): Dashboard => ({
  schemaVersion: 1,
  updatedAt: "2026-10-27T00:00:00Z",
  projects: [
    {
      id: "p1",
      title: "Shared",
      date: "2026-10-27",
      stage: "editing",
      nextAction: "Review",
      publicURL: "https://example.com/reel",
      shared: true,
    },
    {
      id: "p2",
      title: "Private",
      date: "2026-10-27",
      stage: "idea",
      nextAction: "",
      publicURL: "",
      shared: false,
    },
  ],
});
test("snapshot allowlist excludes private projects and extra source fields", () => {
  const d = sample();
  Object.assign(d.projects[0], {
    sourcePath: "/private/source",
    ocr: "private text",
    assetIDs: ["private-id"],
  });
  const s = toSnapshot(d);
  assert.equal(s.projects.length, 1);
  assert.deepEqual(Object.keys(s.projects[0]).sort(), [
    "date",
    "id",
    "nextAction",
    "publicURL",
    "stage",
    "title",
  ]);
  assert.equal(JSON.stringify(s).includes("private"), false);
});
test("invalid links, duplicate IDs, schema and date rejected", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com",
  ]) {
    const d = sample();
    d.projects[0].publicURL = url;
    assert.throws(() => validateDashboard(d));
  }
  const d = sample();
  d.projects[1].id = "p1";
  assert.throws(() => validateDashboard(d));
  assert.throws(() => fromSnapshot({ schemaVersion: 2, projects: [] }));
  assert.throws(() =>
    fromSnapshot({ schemaVersion: 1, generatedAt: "bad", projects: [] }),
  );
});
test("web snapshot reconstructs only readable dashboard fields", () => {
  const s = toSnapshot(sample());
  const d = fromSnapshot(s);
  assert.equal(d.projects.length, 1);
  assert.equal(d.projects[0].shared, true);
});
