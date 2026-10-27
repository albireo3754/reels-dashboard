import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "This installer regression requires macOS");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repo, "native", "photosindex", "scripts", "install-cli.sh");
const builtApp = path.join(repo, "native", "photosindex", ".build", "PhotosIndex.app");
assert.ok(existsSync(builtApp), "Build native artifacts before running this test");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "reels-install-")));
const installRoot = path.join(root, "설치 공간");
const support = path.join(root, "support");
mkdirSync(support);
const launcher = path.join(installRoot, "bin", "photosindex");
const pair = path.join(installRoot, "lib", "reels-dashboard");
const installedCLI = path.join(pair, "photosindex");
const installedApp = path.join(pair, "PhotosIndex.app");
const installedExecutable = path.join(installedApp, "Contents", "MacOS", "PhotosIndex");
const socketPath = `/tmp/reels-install-${randomUUID().slice(0, 8)}.sock`;
const metadata = path.join(support, "helper-instance.json");
const env = { ...process.env, PHOTOSINDEX_INSTALL_ROOT: installRoot, PHOTOSINDEX_SOCKET_PATH: socketPath, PHOTOSINDEX_SUPPORT_ROOT: support };
// Prove default discovery works; do not override HOME or touch the user's install.
delete env.PHOTOSINDEX_APP_PATH;
const instances = [];

function install() {
  const child = spawn("/bin/zsh", [installer], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-12000); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Install failed (${code ?? signal}):\n${output}`)));
  });
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${message}`);
}

function rawStatus() {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection({ path: socketPath });
    let response = "";
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5000, () => fail(new Error("Status timeout")));
    socket.once("error", fail);
    socket.once("end", () => fail(new Error("Status EOF before a complete response")));
    socket.once("close", () => fail(new Error("Status closed before a complete response")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ protocolVersion: 1, id, method: "status", arguments: {} })}\n`));
    socket.on("data", chunk => {
      if (settled) return;
      response += chunk;
      if (!response.includes("\n")) return;
      try {
        const envelope = JSON.parse(response.split("\n")[0]);
        assert.equal(envelope.id, id);
        assert.equal(envelope.ok, true);
        assert.equal(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")).protocolVersion, 1);
        settled = true;
        socket.end();
        resolve();
      } catch (error) { fail(error); }
    });
  });
}

async function launch(appOverride) {
  const launchEnv = appOverride ? { ...env, PHOTOSINDEX_APP_PATH: appOverride } : env;
  const status = JSON.parse(execFileSync(launcher, ["status", "--format", "json"], { cwd: root, env: launchEnv, encoding: "utf8", timeout: 15000 }));
  assert.equal(status.protocolVersion, 1);
  await waitUntil(() => existsSync(metadata), "instance record");
  const instance = JSON.parse(readFileSync(metadata, "utf8"));
  instances.push(instance);
  const expectedExecutable = path.join(appOverride ?? installedApp, "Contents", "MacOS", "PhotosIndex");
  assert.equal(realpathSync(instance.executablePath).normalize("NFC"), realpathSync(expectedExecutable).normalize("NFC"));
  assert.equal(instance.socketPath, socketPath);
  return instance;
}

async function stop(instance) {
  const current = existsSync(metadata) ? JSON.parse(readFileSync(metadata, "utf8")) : null;
  if (current?.instanceID !== instance.instanceID) return;
  let command;
  try { command = execFileSync("/bin/ps", ["-p", String(instance.pid), "-o", "command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8" }, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return; }
  const processExecutable = execFileSync("/bin/ps", ["-ww", "-p", String(instance.pid), "-o", "comm="], { encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8" } }).trim();
  assert.equal(realpathSync(processExecutable).normalize("NFC"), realpathSync(instance.executablePath).normalize("NFC"), "Only stop this test's known executable");
  assert.ok(command.includes(socketPath), "Only stop this test's known socket owner");
  process.kill(instance.pid, "SIGTERM");
  await waitUntil(() => !existsSync(metadata) && !existsSync(socketPath), "helper shutdown");
}

try {
  await install();
  execFileSync(launcher, ["--help"], { cwd: root, env, timeout: 10000, stdio: "pipe" });
  const first = await launch();
  const oldCLI = statSync(installedCLI).ino;
  const oldHelper = statSync(installedExecutable).ino;
  const oldLauncher = statSync(launcher).ino;
  let reinstalling = true;
  let failure;
  const reinstalled = install().catch(error => { failure = error; }).finally(() => { reinstalling = false; });
  let responses = 0;
  while (reinstalling) {
    await rawStatus();
    responses++;
    await delay(20);
  }
  await reinstalled;
  if (failure) throw failure;
  assert.ok(responses > 0);
  assert.notEqual(statSync(installedCLI).ino, oldCLI);
  assert.notEqual(statSync(installedExecutable).ino, oldHelper);
  assert.notEqual(statSync(launcher).ino, oldLauncher);
  assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), first);
  execFileSync(launcher, ["--help"], { cwd: root, env, timeout: 10000, stdio: "pipe" });
  const freshCLIStatus = JSON.parse(execFileSync(launcher, ["status", "--format", "json"], { cwd: root, env, encoding: "utf8", timeout: 10000 }));
  assert.equal(freshCLIStatus.protocolVersion, 1);
  assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), first, "New launcher must not silently relaunch a crashed helper");
  await rawStatus();
  await stop(first);
  const second = await launch();
  assert.notEqual(second.instanceID, first.instanceID);
  await stop(second);
  const overridden = await launch(builtApp);
  await rawStatus();
  await stop(overridden);
  // Exercise production request/dispose under a locale that makes ps escape
  // non-ASCII paths. A QA-only stop() success must not hide production failure.
  try {
    const output = execFileSync(process.execPath, [
      "--import", "tsx",
      path.join(repo, "tests", "electron", "native-client-install-runner.ts"),
      JSON.stringify({ cli: installedCLI, app: installedApp, socket: socketPath, support }),
    ], { cwd: repo, env: { ...env, LC_ALL: "C", LANG: "C" }, encoding: "utf8", timeout: 30000 });
    process.stdout.write(output);
  } finally {
    // The production assertion can fail before disposal. Preserve independent
    // test cleanup, which validates the exact executable and unique socket.
    if (existsSync(metadata)) instances.push(JSON.parse(readFileSync(metadata, "utf8")));
  }
  console.log(`PASS: temporary Unicode/spaced install; default paired discovery; ${responses} status responses during reinstall; old helper survived; new CLI/helper restart; explicit app override; production NativeClient lifecycle`);
} finally {
  for (const instance of instances.reverse()) await stop(instance);
  rmSync(root, { recursive: true, force: true });
}
