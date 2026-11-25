import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Synthetic origin + release root; --no-services keeps launchctl and the real bridge out of it.
const script = path.resolve("scripts/live-install.mjs");
const temps: string[] = [];
test.after(async () => { for (const d of temps) await rm(d, { recursive: true, force: true }); });

async function world() {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-install-"));
  temps.push(root);
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const origin = path.join(root, "origin.git"), dev = path.join(root, "dev"), live = path.join(root, "live"), data = path.join(root, "data");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  g(root, "clone", "-q", origin, dev);
  for (const [k, v] of [["user.email", "t@example.invalid"], ["user.name", "t"]]) g(dev, "config", k, v);
  const pkg = (build: string) => JSON.stringify({ name: "x", private: true, scripts: { "build:desktop": build } });
  const lock = JSON.stringify({ name: "x", lockfileVersion: 3, requires: true, packages: { "": { name: "x" } } });
  const commit = async (files: Record<string, string>, msg: string) => {
    for (const [f, c] of Object.entries(files)) { await mkdir(path.dirname(path.join(dev, f)), { recursive: true }); await writeFile(path.join(dev, f), c); }
    g(dev, "add", "-A"); g(dev, "commit", "-qm", msg); g(dev, "push", "-q", "origin", "main");
    return g(dev, "rev-parse", "HEAD");
  };
  const v1 = await commit({ "package.json": pkg("node -e 0"), "package-lock.json": lock, "app.txt": "v1" }, "v1");
  const install = (args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, "--no-services", "--skip-tests", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, REELS_LIVE_ROOT: live, REELS_LIVE_ORIGIN: origin, REELS_USER_DATA: data, REELS_LIVE_TEST_PRUNE_NOW: "1", ...env } });
  const current = async () => path.basename(await readlink(path.join(live, "current")).catch(() => "none"));
  const record = async () => JSON.parse(await readFile(path.join(live, "install.json"), "utf8")).last;
  return { root, dev, live, g, pkg, commit, install, current, record, v1 };
}

test("first install builds a release folder and points current at it; dry run changes nothing", async () => {
  const w = await world();
  const dry = w.install(["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /live none -> /);
  assert.equal(await w.current(), "none");
  const r = w.install();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(await w.current(), w.v1);
  assert.equal(await readFile(path.join(w.live, "current/app.txt"), "utf8"), "v1");
  assert.equal((await w.record()).result, "installed");
  const again = w.install();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already built/);
});

test("a failing build never switches; a failing verification switches back", async () => {
  const w = await world();
  w.install();
  await w.commit({ "package.json": w.pkg("node -e process.exit(1)") }, "broken build");
  let r = w.install();
  assert.equal(r.status, 1);
  assert.equal(await w.current(), w.v1);
  assert.equal((await w.record()).result, "build_failed");
  const v3 = await w.commit({ "package.json": w.pkg("node -e 0"), "app.txt": "v3" }, "fixed");
  r = w.install([], { REELS_LIVE_TEST_VERIFY: "fail" });
  assert.equal(r.status, 1);
  assert.equal(await w.current(), w.v1, "switched back");
  assert.equal((await w.record()).result, "restored");
  r = w.install();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await w.current(), v3);
});

test("site inputs need --site-deployed with the exact target; app inputs are reported", async () => {
  const w = await world();
  w.install();
  const s = await w.commit({ "packages/briefing/ui.ts": "1" }, "shared ui");
  let r = w.install();
  assert.match(r.stderr, /site inputs changed/);
  r = w.install(["--site-deployed=" + w.v1]);
  assert.match(r.stderr, /site inputs changed/);
  r = w.install(["--site-deployed=" + s]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /app inputs CHANGED/, "packages/briefing is bundled into the app too");
  const d = await w.commit({ "docs/x.md": "1", "tests/unit/a.test.ts": "1" }, "docs");
  r = w.install();
  assert.match(r.stdout, /app inputs unchanged/);
  assert.equal(await w.current(), d);
});

test("one install at a time; old releases are pruned, current and previous kept", async () => {
  const w = await world();
  w.install();
  await writeFile(path.join(w.live, "install.lock"), String(process.pid));
  await w.commit({ "app.txt": "x" }, "x");
  let r = w.install();
  assert.match(r.stderr, /another live install is running/);
  await rm(path.join(w.live, "install.lock"));
  for (let i = 0; i < 4; i++) { await w.commit({ "app.txt": "n" + i }, "n" + i); r = w.install(); assert.equal(r.status, 0, r.stderr); }
  const dirs = (await readdir(path.join(w.live, "releases"))).filter((d) => /^[0-9a-f]{40}$/.test(d));
  assert.ok(dirs.length <= 3, String(dirs.length));
  assert.ok(dirs.includes(await w.current()));
});

test("after an interruption right after the switch, the restore target is the last confirmed release", async () => {
  const w = await world();
  w.install();
  const v2 = await w.commit({ "app.txt": "v2" }, "v2");
  // Build v2 and leave current on it without confirming, as if the installer died after switchTo.
  w.install([], { REELS_LIVE_TEST_VERIFY: "fail" });
  const { symlink, rename: mv } = await import("node:fs/promises");
  await symlink(path.join("releases", v2), path.join(w.live, "current.tmp"));
  await mv(path.join(w.live, "current.tmp"), path.join(w.live, "current"));
  const r = w.install([], { REELS_LIVE_TEST_VERIFY: "fail" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /never confirmed; the restore target stays/);
  assert.equal(await w.current(), w.v1);
  assert.equal((await w.record()).result, "restored");
});

test("pruning waits while a process runs through current/", async () => {
  const w = await world();
  w.install();
  for (let i = 0; i < 2; i++) { await w.commit({ "app.txt": "m" + i }, "m" + i); w.install(); }
  const { spawn } = await import("node:child_process");
  await writeFile(path.join(w.live, "hold.cjs"), "setTimeout(()=>{},60000)");
  const holder = spawn(process.execPath, [path.join(w.live, "current") + "/../hold.cjs", "--tag", path.join(w.live, "current") + "/x"], { stdio: "ignore" });
  try {
    const before = (await readdir(path.join(w.live, "releases"))).filter((d) => /^[0-9a-f]{40}$/.test(d)).sort();
    await w.commit({ "app.txt": "m9" }, "m9");
    const r = w.install();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pruning deferred/);
    const after = (await readdir(path.join(w.live, "releases"))).filter((d) => /^[0-9a-f]{40}$/.test(d));
    for (const d of before) assert.ok(after.includes(d), "nothing removed while a current/ process runs");
  } finally { holder.kill(); }
});
