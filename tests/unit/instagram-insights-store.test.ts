import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InstagramInsightsStore } from "../../src/shared/lib/instagram-insights-store";
import {
  insightRates,
  insightMedian,
  insightsCohort,
  insightsGroups,
  instagramProject,
} from "../../src/shared/instagram-insights";
import { fixturePost, fixtureSnapshot } from "../fixtures/instagram-insights";
import { InstagramInsightsClient } from "../../packages/instagram-insights/index.mjs";
const token = "synthetic-private-credential-" + "x".repeat(60);
function fakeApi(
  control: { fail?: boolean; deny?: boolean; wrongOwner?: boolean; gate?: Promise<void> } = {},
) {
  return async (url: URL, init: RequestInit) => {
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(init.redirect, "error");
    assert.equal(url.searchParams.has("access_token"), false);
    if (url.pathname.endsWith("/assigned_instagram_accounts"))
      return Response.json({
        data: [{ id: "10001", username: "creator_demo" }],
      });
    if (url.pathname.endsWith("/10001"))
      return Response.json({
        id: "10001",
        username: control.wrongOwner ? "other_account" : "creator_demo",
        followers_count: 200,
        media_count: 1,
      });
    if (url.pathname.endsWith("/media"))
      return Response.json({
        data: [
          {
            id: "101",
            permalink: "https://www.instagram.com/reel/Example101/",
            media_type: "VIDEO",
            media_product_type: "REELS",
            timestamp: "2026-09-24T12:00:00+0000",
            caption: "Synthetic example",
          },
        ],
      });
    if (control.gate) await control.gate;
    if (control.fail)
      return Response.json(
        { error: { code: 4, message: token } },
        { status: 429 },
      );
    if (control.deny) return Response.json({error:{code:200,message:token}},{status:400});
    return Response.json({
      data: ["views", "reach", "likes", "comments", "saved", "shares"].map(
        (name) => ({
          name,
          values: [
            { value: name === "reach" ? 100 : name === "saved" ? 0 : 10 },
          ],
        }),
      ),
    });
  };
}
async function setup(control: Parameters<typeof fakeApi>[0] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "reels-instagram-unit-"));
  const credential = path.join(root, "credential");
  await writeFile(credential, token, { mode: 0o600 });
  return {
    root,
    credential,
    store: new InstagramInsightsStore(root, fakeApi(control)),
  };
}
test("unified owner IDs, private persistence, zero metrics, topics and restart survive without returning credentials", async () => {
  const { root, credential, store } = await setup();
  try {
    await store.connect(
      { username: "@Creator_Demo", login: "unified" },
      credential,
    );
    const state = await store.refresh();
    assert.equal(state.snapshot?.account.username, "creator_demo");
    assert.equal(
      state.snapshot?.media[0]?.metrics.find((m) => m.metric === "saved")
        ?.value,
      0,
    );
    assert.ok(!JSON.stringify(state).includes(token));
    assert.ok(!JSON.stringify(state).includes(credential));
    assert.equal(
      (await stat(path.join(root, "instagram-connection.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (
        await stat(
          path.join(root, "instagram-snapshots", `${state.snapshot!.id}.json`),
        )
      ).mode & 0o777,
      0o600,
    );
    assert.ok(
      !(
        await readFile(path.join(root, "instagram-connection.json"), "utf8")
      ).includes(token),
    );
    await store.setTopics({ 101: "음식" });
    assert.equal(
      (await new InstagramInsightsStore(root).get()).topics["101"],
      "음식",
    );
    await assert.rejects(
      store.setTopics({ 999: "foreign" }),
      /INSTAGRAM_MEDIA/,
    );
    await assert.rejects(
      store.get({ snapshotId: "99999999-9999-4999-8999-999999999999" }),
      /INSTAGRAM_SNAPSHOT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("owner mismatch and masked credentials cannot replace an existing connection", async () => {
  const control = { wrongOwner: false };
  const { root, credential, store } = await setup(control);
  try {
    await store.connect(
      { username: "creator_demo", login: "unified" },
      credential,
    );
    control.wrongOwner = true;
    await assert.rejects(
      store.connect({ username: "creator_demo", login: "unified" }, credential),
      /ACCOUNT_MISMATCH/,
    );
    await writeFile(credential, "fixture" + "●".repeat(100), { mode: 0o600 });
    await assert.rejects(
      store.connect({ username: "creator_demo", login: "unified" }, credential),
      /INSTAGRAM_TOKEN/,
    );
    assert.equal((await store.get()).connection?.tokenReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("rate limit preserves the last successful snapshot and concurrent refresh cannot duplicate requests", async () => {
  const control: { fail: boolean; deny?: boolean; gate?: Promise<void> } = { fail: false };
  const { root, credential, store } = await setup(control);
  try {
    await store.connect(
      { username: "creator_demo", login: "unified" },
      credential,
    );
    const previous = await store.refresh();
    control.fail = true;
    await assert.rejects(store.refresh(), /HTTP 429/);
    assert.equal((await store.get()).snapshot?.id, previous.snapshot?.id);
    assert.equal((await store.get()).history.length, 1);
    control.fail = false;
    control.deny = true;
    await assert.rejects(store.refresh(),/INSTAGRAM_INSIGHTS_UNAVAILABLE/);
    assert.equal((await store.get()).snapshot?.id,previous.snapshot?.id);
    control.deny = false;
    let release!: () => void;
    control.gate = new Promise<void>((resolve) => (release = resolve));
    const pending = store.refresh();
    await assert.rejects(store.refresh(), /INSTAGRAM_BUSY/);
    release();
    await pending;
    assert.equal((await store.get()).history.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("KST holiday boundaries, recent reels, carousel exclusions and median denominators", () => {
  const snapshot = fixtureSnapshot();
  const filter = { matureOnly: true, excludeFrom: "", excludeTo: "" };
  const mature = insightsCohort(snapshot, filter);
  assert.equal(mature.length, 2);
  assert.equal(
    insightMedian(mature.map((p) => insightRates(p).interaction)),
    15,
  );
  const excluded = insightsCohort(snapshot, {
    ...filter,
    excludeFrom: "2026-09-24",
    excludeTo: "2026-09-27",
  });
  assert.equal(excluded.length, 1);
  assert.equal(insightRates(excluded[0]!).interaction, 10);
  const missing = fixturePost("999", "2026-09-27T15:00:00Z");
  missing.metrics = missing.metrics.filter((m) => m.metric !== "shares");
  assert.equal(insightRates(missing).interaction, null);
  missing.metrics.find((m) => m.metric === "reach")!.value = 0;
  assert.equal(insightRates(missing).saved, null);
  const groups = insightsGroups(mature, "weekday", {}, "shares");
  assert.equal(
    groups.reduce((n, g) => n + g.count, 0),
    2,
  );
  const p = fixturePost("101", "2026-09-24T12:00:00Z");
  assert.equal(
    instagramProject(p, [
      {
        id: "linked",
        title: "Linked",
        publicURL: "https://www.instagram.com/creator_demo/reel/Example101/",
        date: "2026-09-24",
        stage: "published",
        nextAction: "",
        shared: false,
      },
    ])?.id,
    "linked",
  );
});
test("SDK rejects display masks and stops once on auth or throttling errors", async () => {
  assert.throws(
    () => new InstagramInsightsClient({ accessToken: "●".repeat(60), expectedUsername: "creator_demo" }),
  );
  for (const [status, code] of [
    [401, 190],
    [429, 4],
  ]) {
    let calls = 0;
    const client = new InstagramInsightsClient({
      accessToken: token,
      expectedUsername: "creator_demo",
      login: "unified",
      fetchImpl: async () => {
        calls++;
        return Response.json({ error: { code, message: token } }, { status });
      },
    });
    await assert.rejects(
      client.insights({
        id: "101",
        permalink: "https://www.instagram.com/reel/Example101/",
      }),
      (e) => !String(e).includes(token),
    );
    assert.equal(calls, 1);
  }
});
test("background collection reports failure after returning and keeps the old snapshot", async () => {
  const { root, credential, store } = await setup();
  try {
    await store.connect(
      { username: "creator_demo", login: "unified" },
      credential,
    );
    const previous = await store.refresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const background = new InstagramInsightsStore(
      root,
      fakeApi({ fail: true, gate }),
      () => {
        if (!background.busy) settled();
      },
    );
    const started = await background.startRefresh();
    assert.equal(started.busy, true);
    assert.equal(started.snapshot?.id, previous.snapshot?.id);
    assert.throws(() => background.startRefresh(), /INSTAGRAM_BUSY/);
    release();
    await done;
    const failed = await background.get();
    assert.equal(failed.busy, false);
    assert.match(failed.lastError!, /HTTP 429/);
    assert.ok(!failed.lastError?.includes(token));
    assert.equal(failed.snapshot?.id, previous.snapshot?.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
