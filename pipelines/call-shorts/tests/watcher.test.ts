import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { StateStore } from "../src/state.js";
import {
  InboxScanner,
  discoverAudioFiles,
  isIcloudPlaceholder,
  isProcessable,
  isStable,
  sha256File,
} from "../src/watcher.js";
import { makeConfig } from "./helpers.js";

class FakeClock {
  now = 0;
  sleep = async (ms: number): Promise<void> => {
    this.now += ms;
  };
  clock = (): number => this.now;
}

test(".icloud placeholder detection", () => {
  assert.equal(isIcloudPlaceholder(".통화.m4a.icloud"), true);
  assert.equal(isIcloudPlaceholder("call.m4a.icloud"), true);
  assert.equal(isIcloudPlaceholder("call.m4a"), false);
});

test("discovery skips hidden files, placeholders and other extensions", () => {
  const config = makeConfig();
  writeFileSync(path.join(config.inboxDir, "a.m4a"), "a");
  writeFileSync(path.join(config.inboxDir, "b.mp3"), "b");
  writeFileSync(path.join(config.inboxDir, "note.txt"), "x");
  writeFileSync(path.join(config.inboxDir, ".hidden.m4a"), "h");
  writeFileSync(path.join(config.inboxDir, ".c.m4a.icloud"), "p");

  assert.deepEqual(
    discoverAudioFiles(config.inboxDir, [".m4a", ".mp3"]).map((file) => path.basename(file)),
    ["a.m4a", "b.mp3"],
  );
  assert.equal(isProcessable(path.join(config.inboxDir, ".c.m4a.icloud"), [".m4a"]), false);
  assert.equal(isProcessable(path.join(config.inboxDir, ".hidden.m4a"), [".m4a"]), false);
});

test("stability waits until the size stops changing", async () => {
  const clock = new FakeClock();
  const sizes = [100, 100, 500, 500, 500, 500, 500];
  let index = 0;
  const ok = await isStable("/tmp/whatever.m4a", 20, {
    pollMs: 5000,
    sleep: clock.sleep,
    now: clock.clock,
    sizeOf: () => sizes[Math.min(index++, sizes.length - 1)],
  });
  assert.equal(ok, true);
});

test("stability times out when the file keeps growing", async () => {
  const clock = new FakeClock();
  let size = 0;
  const ok = await isStable("/tmp/growing.m4a", 20, {
    pollMs: 5000,
    timeoutMs: 30000,
    sleep: clock.sleep,
    now: clock.clock,
    sizeOf: () => (size += 10),
  });
  assert.equal(ok, false);
});

test("zero-size file is never stable", async () => {
  const clock = new FakeClock();
  const ok = await isStable("/tmp/empty.m4a", 0, {
    pollMs: 1000,
    timeoutMs: 5000,
    sleep: clock.sleep,
    now: clock.clock,
    sizeOf: () => 0,
  });
  assert.equal(ok, false);
});

test("scan marks a new file, then a duplicate after processing", async () => {
  const config = makeConfig();
  const store = new StateStore(config.stateFile);
  const source = path.join(config.inboxDir, "call.m4a");
  writeFileSync(source, "voice-data-".repeat(100));

  const scanner = new InboxScanner(config, store);
  const first = (await scanner.scan()).find((item) => item.path === source)!;
  assert.equal(first.status, "new");
  assert.equal(first.sha256, await sha256File(source));
  assert.ok(first.size > 0);

  assert.equal(store.claimFile(first.sha256!, source, first.size), true);
  store.setFileStatus(first.sha256!, "done", { projectDir: path.join(config.projectsDir, "2026-11-22_EP01") });

  const second = (await scanner.scan()).find((item) => item.path === source)!;
  assert.equal(second.status, "duplicate");
  assert.match(second.reason, /이미 처리한 해시/);
});

test("scan reports placeholders and empty files", async () => {
  const config = makeConfig();
  const store = new StateStore(config.stateFile);
  mkdirSync(config.inboxDir, { recursive: true });
  writeFileSync(path.join(config.inboxDir, ".call.m4a.icloud"), "placeholder");
  writeFileSync(path.join(config.inboxDir, "empty.m4a"), "");

  const items = await new InboxScanner(config, store).scan();
  assert.equal(items.find((item) => item.path.endsWith(".icloud"))?.status, "placeholder");
  assert.equal(items.find((item) => item.path.endsWith("empty.m4a"))?.status, "unstable");
});

test("force retries a failed hash", async () => {
  const config = makeConfig();
  const store = new StateStore(config.stateFile);
  const source = path.join(config.inboxDir, "call.m4a");
  writeFileSync(source, "retry-me");
  const digest = await sha256File(source);
  store.claimFile(digest, source, 8);
  store.setFileStatus(digest, "failed", { error: "boom" });

  const scanner = new InboxScanner(config, store);
  assert.equal((await scanner.scan()).find((item) => item.path === source)?.status, "duplicate");
  const retried = (await scanner.scan(true)).find((item) => item.path === source)!;
  assert.equal(retried.status, "new");
  assert.match(retried.reason, /재시도/);
});

test("hash is stable regardless of chunk boundaries", async () => {
  const config = makeConfig();
  const a = path.join(config.inboxDir, "a.m4a");
  const b = path.join(config.inboxDir, "b.m4a");
  writeFileSync(a, "same".repeat(1000));
  writeFileSync(b, "same".repeat(1000));
  assert.equal(await sha256File(a), await sha256File(b));
});
