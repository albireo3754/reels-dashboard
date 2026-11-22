import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Pipeline } from "../src/runner.js";
import { StateStore } from "../src/state.js";
import { InboxScanner, sha256File, stuckProcessingFiles } from "../src/watcher.js";
import { makeDryConfig } from "./helpers.js";

const HOUR = 3_600_000;

function pipeline(config: ReturnType<typeof makeDryConfig>, store?: StateStore): Pipeline {
  return new Pipeline(config, store, { executeRender: false, notifier: () => undefined });
}

function backdateState(file: string, digest: string, hours: number): void {
  const data = JSON.parse(readFileSync(file, "utf8")) as { files: Record<string, { updatedAt: string }> };
  data.files[digest].updatedAt = new Date(Date.now() - hours * HOUR).toISOString();
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

test("run-once --force recovers a hash left in processing by a killed run", async () => {
  const config = makeDryConfig();
  const audio = path.join(config.inboxDir, "call.m4a");
  writeFileSync(audio, Buffer.alloc(2048, 7));
  const digest = await sha256File(audio);

  const store = new StateStore(config.stateFile);
  assert.equal(store.claimFile(digest, audio, 2048), true);
  assert.equal(store.getFile(digest)?.status, "processing");

  const scanner = new InboxScanner(config, store);
  assert.equal((await scanner.scan()).find((item) => item.path === audio)?.status, "duplicate");
  assert.equal((await scanner.scan(true)).find((item) => item.path === audio)?.status, "new");

  const results = await pipeline(config).runOnce({ force: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "done", results[0].message);
  assert.match(path.basename(results[0].projectDir), /_EP01$/);

  assert.equal(new StateStore(config.stateFile).getFile(digest)?.status, "done");
  assert.equal(readdirSync(config.projectsDir).length, 1, "복구는 같은 프로젝트를 이어서 합니다");
});

test("a processing record older than three hours is retried without --force", async () => {
  const config = makeDryConfig();
  const audio = path.join(config.inboxDir, "call.m4a");
  writeFileSync(audio, Buffer.alloc(2048, 9));
  const digest = await sha256File(audio);
  new StateStore(config.stateFile).claimFile(digest, audio, 2048);
  backdateState(config.stateFile, digest, 4);

  const store = new StateStore(config.stateFile);
  assert.equal(stuckProcessingFiles(store).length, 1);
  const item = (await new InboxScanner(config, store).scan()).find((entry) => entry.path === audio)!;
  assert.equal(item.status, "new");
  assert.match(item.reason, /고착 복구/);

  const results = await pipeline(config, store).runOnce();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "done", results[0].message);
});

test("a fresh processing record is not retried without --force", async () => {
  const config = makeDryConfig();
  const audio = path.join(config.inboxDir, "call.m4a");
  writeFileSync(audio, Buffer.alloc(2048, 11));
  const digest = await sha256File(audio);
  new StateStore(config.stateFile).claimFile(digest, audio, 2048);

  const results = await pipeline(config).runOnce();
  assert.deepEqual(results, []);
  assert.equal(new StateStore(config.stateFile).getFile(digest)?.status, "processing");
  assert.equal(stuckProcessingFiles(new StateStore(config.stateFile)).length, 0);
  assert.ok(!readdirSync(path.join(config.rootDir, "state")).some((name) => name.includes(".corrupt-")));
});

test("status reports how many files are stuck in processing", async () => {
  const config = makeDryConfig();
  mkdirSync(config.inboxDir, { recursive: true });
  const audio = path.join(config.inboxDir, "call.m4a");
  writeFileSync(audio, Buffer.alloc(1024, 3));
  const digest = await sha256File(audio);
  new StateStore(config.stateFile).claimFile(digest, audio, 1024);
  backdateState(config.stateFile, digest, 5);

  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  try {
    const { main } = await import("../src/cli.js");
    assert.equal(await main(["status", "--root", config.rootDir]), 0);
  } finally {
    console.log = original;
  }
  assert.match(output.join("\n"), /처리 중 1건 \(3시간 이상 고착 1건\)/);
});
