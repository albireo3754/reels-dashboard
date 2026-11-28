import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { PowerMonitor } from "electron";
import { EditsFinalShare } from "../../src/desktop/edits-final-share";
import { EditsShareSession } from "../../src/desktop/edits-share-session";
import type { Project } from "../../src/shared/contracts";
import { countEditsCaption, isEditsCaption } from "../../src/shared/edits-final-share";
import type { EditsNativePort } from "../../src/shared/edits";

const preview = {
  fingerprint: "a".repeat(64), windowKey: "b".repeat(64),
  image: "data:image/png;base64,AAA=", account: "@fixture", caption: "",
};
const confirmed = { state: "confirmed", url: "https://www.instagram.com/p/Fixture1/" };
const storeProject: Project = {
  id: "fixture", title: "Fixture", stage: "editing", date: "", nextAction: "",
  publicURL: "", shared: false, publications: [{ channel: "instagram", status: "planned", url: "" }],
};
class FakeMonitor extends EventEmitter {
  idle = "active";
  getSystemIdleState() { return this.idle; }
}
function session() {
  const monitor = new FakeMonitor();
  const value = new EditsShareSession(monitor as unknown as PowerMonitor);
  return { monitor, value };
}

test("unlock belongs to the observed session, including across separate operations", async () => {
  const { monitor, value } = session();
  async function observedUnlock() {
    const lease = value.watch();
    try { return JSON.parse(await readFile(lease.file, "utf8")).observedUnlock; }
    finally { lease.close(); }
  }
  assert.equal(await observedUnlock(), false);
  monitor.emit("user-did-become-active");
  assert.equal(await observedUnlock(), false);
  monitor.emit("unlock-screen");
  assert.equal(await observedUnlock(), true);
  assert.equal(await observedUnlock(), true);

  const lease = value.watch();
  const oldRevision = value.revision;
  monitor.emit("lock-screen");
  assert.ok(value.revision > oldRevision);
  assert.ok(value.blocked);
  await assert.rejects(readFile(lease.file), { code: "ENOENT" });
  monitor.emit("unlock-screen");
  assert.equal(await observedUnlock(), true);

  monitor.emit("suspend");
  monitor.emit("resume");
  assert.equal(await observedUnlock(), false);
  monitor.emit("unlock-screen");
  monitor.emit("user-did-resign-active");
  monitor.emit("user-did-become-active");
  assert.equal(await observedUnlock(), false);

  monitor.emit("unlock-screen");
  monitor.idle = "locked";
  assert.ok(value.blocked);
  monitor.idle = "active";
  assert.equal(await observedUnlock(), false);
  assert.equal(await (async () => {
    const fresh = session().value.watch();
    try { return JSON.parse(await readFile(fresh.file, "utf8")).observedUnlock; }
    finally { fresh.close(); }
  })(), false);
});

async function setup(t: TestContext, native: EditsNativePort, project = () => storeProject) {
  const root = await mkdtemp(path.join(tmpdir(), "reels-share-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = () => new EditsFinalShare(root, native, async (id) => id === storeProject.id ? project() : undefined, session().value);
  return { root, start };
}

test("concurrent confirmation reserves both keys before dispatch and records one result", async (t) => {
  let reached!: () => void;
  let finish!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => { reached = resolve; });
  const dispatchFinished = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const { root, start } = await setup(t, {
    async invoke(operation) {
      if (operation === "final-share-preview") return preview;
      calls++;
      reached();
      await dispatchFinished;
      return confirmed;
    },
  });
  const service = start();
  const ready = await service.preview("fixture");
  assert.equal(ready.state, "ready");
  const first = service.confirm("fixture", ready.token);
  try {
    await dispatchStarted;
    const keys = await readdir(path.join(root, "edits-final-share"));
    assert.equal(keys.length, 2);
    for (const key of keys) {
      assert.deepEqual(JSON.parse(await readFile(path.join(root, "edits-final-share", key), "utf8")), { state: "pending", windowKey: preview.windowKey });
    }
    assert.deepEqual(await service.confirm("fixture", ready.token), { state: "blocked", reason: "busy" });
  } finally {
    finish();
  }
  assert.deepEqual(await first, confirmed);
  assert.deepEqual(await start().preview("fixture"), confirmed);
  assert.equal(calls, 1);
});

test("changed card or cancelled token requires a fresh preview", async (t) => {
  let project = storeProject;
  const { start } = await setup(t, {
    async invoke(operation) {
      assert.equal(operation, "final-share-preview");
      return preview;
    },
  }, () => project);
  const service = start();
  const ready = await service.preview("fixture");
  assert.equal(ready.state, "ready");
  project = { ...project, title: "Different project title" };
  assert.deepEqual(await service.confirm("fixture", ready.token), { state: "blocked", reason: "changed" });
  const fresh = await service.preview("fixture");
  assert.equal(fresh.state, "ready");
  service.cancel(fresh.token);
  assert.deepEqual(await service.confirm("fixture", fresh.token), { state: "blocked", reason: "changed" });
});

test("caption uses the Edits character counter and rotates approval only after exact readback", async (t) => {
  assert.equal(countEditsCaption("🫶🏻한"), 2);
  assert.ok(isEditsCaption("🫶🏻".repeat(2200)));
  assert.equal(isEditsCaption("🫶🏻".repeat(2201)), false);
  const copy = "  바다🩵\n\n#여행  ";
  const nativeCalls: string[] = [];
  const { start } = await setup(t, {
    async invoke(op, args) {
      nativeCalls.push(op);
      if (op === "final-share-preview") return preview;
      assert.equal(op, "final-share-caption");
      assert.equal(args.fingerprint, preview.fingerprint);
      assert.equal(args.caption, copy);
      return { ...preview, caption: copy, fingerprint: "c".repeat(64) };
    },
  });
  const service = start();
  const old = await service.preview("fixture");
  assert.equal(old.state, "ready");
  const next = await service.applyCaption("fixture", old.token, copy);
  assert.equal(next.state, "ready");
  assert.notEqual(next.token, old.token);
  assert.equal(next.caption, copy);
  assert.deepEqual(await service.confirm("fixture", old.token), { state: "blocked", reason: "changed" });
  assert.deepEqual(nativeCalls, ["final-share-preview", "final-share-caption"]);
});

test("unverified caption, different sharing window or invalid body cannot authorize Share", async (t) => {
  let reply = { ...preview, caption: "다른 값" };
  const { start } = await setup(t, {
    async invoke(op) {
      if (op === "final-share-preview") return preview;
      assert.equal(op, "final-share-caption");
      return reply;
    },
  });
  const service = start();
  for (const [body, reason] of [["원문", "caption"], ["다른 값", "changed"], ["a".repeat(2201), "caption"]]) {
    const old = await service.preview("fixture");
    assert.equal(old.state, "ready");
    assert.deepEqual(await service.applyCaption("fixture", old.token, body), { state: "blocked", reason });
    assert.deepEqual(await service.confirm("fixture", old.token), { state: "blocked", reason: "changed" });
    reply = { ...reply, windowKey: "e".repeat(64) };
  }
});
