import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "This regression exercises macOS signed native images");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(repo, "scripts", "build-native.mjs");
const cli = path.join(repo, "native", "photosindex", ".build", "photosindex");
const app = path.join(repo, "native", "photosindex", ".build", "PhotosIndex.app");
const executable = path.join(app, "Contents", "MacOS", "PhotosIndex");
const support = mkdtempSync(path.join(os.tmpdir(), "reels-rebuild-"));
const socketPath = `/tmp/reels-rebuild-${randomUUID().slice(0, 8)}.sock`;
const metadata = path.join(support, "helper-instance.json");
// CI/local ad-hoc signing is explicit for this disposable QA build. The product
// build continues to require a development identity unless configured otherwise.
const env = {
  ...process.env,
  PHOTOSINDEX_SIGNING_MODE: process.env.PHOTOSINDEX_SIGNING_MODE ?? "adhoc",
  PHOTOSINDEX_APP_PATH: app,
  PHOTOSINDEX_SOCKET_PATH: socketPath,
  PHOTOSINDEX_SUPPORT_ROOT: support,
};
const instances = [];

function buildNative(overrides = {}) {
  const child = spawn(process.execPath, [build], { cwd: repo, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
  }
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Native build failed (${code ?? signal}):\n${output}`));
    });
  });
  return done;
}

async function waitUntil(predicate, label) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function rawStatus() {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection({ path: socketPath });
    let response = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5000, () => fail(new Error("Native status timed out")));
    socket.once("error", fail);
    socket.once("end", () => fail(new Error("Native status ended before a complete response")));
    socket.once("close", () => fail(new Error("Native status closed before a complete response")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ protocolVersion: 1, id, method: "status", arguments: {} })}\n`));
    socket.on("data", (chunk) => {
      if (settled) return;
      response += chunk;
      if (!response.includes("\n")) return;
      try {
        const envelope = JSON.parse(response.split("\n")[0]);
        assert.equal(envelope.id, id);
        assert.equal(envelope.ok, true);
        const status = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
        assert.equal(status.protocolVersion, 1);
        settled = true;
        socket.end();
        resolve(status);
      } catch (error) { fail(error); }
    });
  });
}

async function startHelper() {
  const status = JSON.parse(execFileSync(cli, ["status", "--format", "json"], { cwd: repo, env, encoding: "utf8", timeout: 15000 }));
  assert.equal(status.protocolVersion, 1);
  await waitUntil(() => existsSync(metadata), "helper identity publication");
  const instance = JSON.parse(readFileSync(metadata, "utf8"));
  assert.equal(instance.executablePath, executable);
  assert.equal(instance.socketPath, socketPath);
  instances.push(instance);
  return instance;
}

async function stopHelper(instance) {
  const current = existsSync(metadata) ? JSON.parse(readFileSync(metadata, "utf8")) : null;
  if (current?.instanceID !== instance.instanceID) return;
  let command;
  try {
    command = execFileSync("/bin/ps", ["-p", String(instance.pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return; }
  assert.ok(command.includes(executable), "Never signal an unrelated process");
  assert.ok(command.includes(socketPath), "Never signal an unrelated helper instance");
  process.kill(instance.pid, "SIGTERM");
  await waitUntil(() => !existsSync(metadata) && !existsSync(socketPath), "helper shutdown");
}

try {
  await buildNative();
  const first = await startHelper();
  const beforeCLI = statSync(cli).ino;
  const beforeHelper = statSync(executable).ino;
  await assert.rejects(buildNative({ PHOTOSINDEX_SIGNING_MODE: "invalid-regression-mode" }), /Unsupported PHOTOSINDEX_SIGNING_MODE/);
  assert.equal(statSync(cli).ino, beforeCLI, "A failed build must preserve the published CLI");
  assert.equal(statSync(executable).ino, beforeHelper, "A failed signature must preserve the published app");
  assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), first);
  await rawStatus();
  let rebuilding = true;
  let failure;
  const rebuild = buildNative().catch((error) => { failure = error; }).finally(() => { rebuilding = false; });
  let responses = 0;
  while (rebuilding) {
    await rawStatus();
    responses++;
    await delay(75);
  }
  await rebuild;
  if (failure) throw failure;
  assert.ok(responses > 0, "Must query the live helper during the rebuild");
  assert.notEqual(statSync(cli).ino, beforeCLI, "CLI publication must replace the inode");
  assert.notEqual(statSync(executable).ino, beforeHelper, "Helper publication must replace the inode");
  assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), first, "A rebuild must not crash/relaunch the original helper");
  await rawStatus();
  execFileSync(cli, ["--help"], { cwd: repo, env, timeout: 10000, stdio: "pipe" });
  const freshCLIStatus = JSON.parse(execFileSync(cli, ["status", "--format", "json"], { cwd: repo, env, encoding: "utf8", timeout: 10000 }));
  assert.equal(freshCLIStatus.protocolVersion, 1);
  assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), first, "Fresh CLI status must not hide a crashed helper by auto-relaunching it");
  await rawStatus();
  await stopHelper(first);
  const second = await startHelper();
  assert.notEqual(second.instanceID, first.instanceID);
  await rawStatus();
  await stopHelper(second);
  console.log(`PASS: failed-signing rollback; ${responses} live status responses during rebuild; replaced CLI/helper inodes; prior helper survived; fresh CLI and helper restart succeeded`);
} finally {
  for (const instance of instances.reverse()) await stopHelper(instance);
  rmSync(support, { recursive: true, force: true });
}
