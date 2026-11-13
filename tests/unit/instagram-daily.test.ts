import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  InstagramInsightsStore,
  instagramFailure,
} from "../../src/shared/lib/instagram-insights-store";
import { InstagramApiError } from "../../packages/instagram-insights/index.mjs";

const credential = "synthetic-test-" + "x".repeat(60);
export function api(gate?: Promise<void>) {
  return async (url: URL) => {
    if (url.pathname.endsWith("/assigned_instagram_accounts"))
      return Response.json({ data: [{ id: "1", username: "creator_demo" }] });
    if (url.pathname.endsWith("/1"))
      return Response.json({ id: "1", username: "creator_demo" });
    if (url.pathname.endsWith("/media"))
      return Response.json({
        data: [
          {
            id: "2",
            permalink: "https://www.instagram.com/reel/Synthetic/",
            timestamp: "2026-11-01T00:00:00Z",
            media_type: "VIDEO",
            media_product_type: "REELS",
          },
        ],
      });
    await gate;
    return Response.json({
      data: url.searchParams
        .get("metric")!
        .split(",")
        .map((name) => ({ name, values: [{ value: 0 }] })),
    });
  };
}
test("separate store owners serialize all writes and keep same-day scheduled and manual snapshots distinct", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "instagram-daily-"));
  try {
    const file = path.join(root, "credential");
    await writeFile(file, credential, { mode: 0o600 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new InstagramInsightsStore(root, api(gate));
    await store.connect(
      {
        username: "creator_demo",
        login: "unified",
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      file,
    );
    const pending = store.refresh("scheduled");
    while (!(await store.get()).busy)
      await new Promise((resolve) => setTimeout(resolve, 1));
    // Wait for the on-disk lock, rather than only the first owner's in-memory flag.
    while (
      await access(path.join(root, "instagram-collection.lock")).then(
        () => false,
        () => true,
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    let requests = 0;
    const other = new InstagramInsightsStore(root, async () => {
      requests++;
      throw new Error("must not call network");
    });
    assert.equal((await other.get()).busy, true);
    await assert.rejects(other.refresh(), /INSTAGRAM_BUSY/);
    await assert.rejects(other.setTopics({}), /INSTAGRAM_BUSY/);
    await assert.rejects(
      other.connect({ username: "creator_demo", login: "unified" }, file),
      /INSTAGRAM_BUSY/,
    );
    assert.equal(requests, 0);
    release();
    const scheduled = await pending;
    assert.equal(scheduled.snapshot?.source, "scheduled");
    assert.equal(scheduled.snapshot?.tokenHealth?.status, "expiring");
    assert.ok(
      scheduled.snapshot?.media[0]?.metrics.some(
        (m) => m.metric === "reels_skip_rate" && m.value === 0,
      ),
    );
    const manual = await store.refresh();
    assert.notEqual(manual.snapshot?.id, scheduled.snapshot?.id);
    assert.deepEqual(
      manual.history.map((h) => h.source),
      ["manual", "scheduled"],
    );
    const saved = JSON.parse(
      await readFile(
        path.join(
          root,
          "instagram-snapshots",
          scheduled.snapshot!.id + ".json",
        ),
        "utf8",
      ),
    );
    assert.equal(saved.source, "scheduled");
    assert.equal(
      (await store.get({ snapshotId: saved.id })).snapshot?.id,
      saved.id,
    );
    // Older snapshots and index entries remain readable without rewriting their bytes.
    delete saved.source;
    delete saved.tokenHealth;
    await writeFile(
      path.join(root, "instagram-snapshots", saved.id + ".json"),
      JSON.stringify(saved),
    );
    const old = JSON.parse(
      await readFile(path.join(root, "instagram-history.json"), "utf8"),
    );
    delete old[1].source;
    await writeFile(
      path.join(root, "instagram-history.json"),
      JSON.stringify(old),
    );
    assert.equal(
      (await store.get({ snapshotId: saved.id })).snapshot?.source,
      "manual",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("fixed error summaries distinguish authentication, permissions, limits and network without secrets", () => {
  for (const [status, code, expected] of [
    [401, 190, "INSTAGRAM_AUTH"],
    [400, 190, "INSTAGRAM_AUTH"],
    [403, 200, "INSTAGRAM_PERMISSION"],
    [400, 10, "INSTAGRAM_PERMISSION"],
    [429, 4, "INSTAGRAM_RATE_LIMIT"],
    [0, "NETWORK_OR_TIMEOUT", "INSTAGRAM_NETWORK"],
  ] as const) {
    assert.equal(
      instagramFailure(new InstagramApiError(status, code)).code,
      expected,
    );
  }
  const secret = "https://credential.example/?access_token=" + credential;
  assert.ok(!new InstagramApiError(400, secret).message.includes(secret));
  assert.ok(
    !JSON.stringify(instagramFailure(new Error(secret))).includes(secret),
  );
});
