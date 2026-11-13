import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLI_LAUNCHER_MARKER, cliLauncher, installCli } from "../../src/desktop/cli-install";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-cli-install-"));
  const bundle = path.join(root, "Resources/cli/reels.mjs");
  await mkdir(path.dirname(bundle), { recursive: true });
  await writeFile(bundle, "console.log(JSON.stringify(process.argv.slice(2)))\n");
  return { root, bundle, binDir: path.join(root, "bin") };
}

test("installs, keeps and refreshes the managed launcher", async () => {
  const { bundle, binDir } = await fixture();
  const first = await installCli({ executable: process.execPath, bundle, binDir });
  assert.equal(first.status, "installed");
  assert.equal((await stat(first.target)).mode & 0o777, 0o755);
  assert.equal((await installCli({ executable: process.execPath, bundle, binDir })).status, "unchanged");
  assert.equal((await installCli({ executable: "/Moved/Reels Dashboard", bundle, binDir })).status, "updated");
  assert.match(await readFile(first.target, "utf8"), /'\/Moved\/Reels Dashboard'/);
});

test("the launcher runs the bundle with the given executable as Node", async () => {
  const { bundle, binDir } = await fixture();
  const { target } = await installCli({ executable: process.execPath, bundle, binDir });
  const out = execFileSync(target, ["status", "it's"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), ["status", "it's"]);
});

test("never replaces a symlink or a file it did not write", async () => {
  const { root, bundle, binDir } = await fixture();
  await mkdir(binDir);
  await symlink(path.join(root, "dev/reels.mjs"), path.join(binDir, "reels"));
  assert.deepEqual(await installCli({ executable: process.execPath, bundle, binDir }), {
    status: "skipped", target: path.join(binDir, "reels"), reason: "foreign_file",
  });
  const result = await installCli({ executable: process.execPath, bundle, binDir: root });
  assert.equal(result.status, "installed");
  await writeFile(result.target, "#!/bin/sh\necho mine\n");
  assert.equal((await installCli({ executable: process.execPath, bundle, binDir: root })).status, "skipped");
  assert.equal(await readFile(result.target, "utf8"), "#!/bin/sh\necho mine\n");
});

test("skips when the app has no bundled CLI", async () => {
  const { root, binDir } = await fixture();
  const result = await installCli({ executable: process.execPath, bundle: path.join(root, "none.mjs"), binDir });
  assert.equal(result.status, "skipped");
  assert.ok(cliLauncher("/a", "/b").includes(CLI_LAUNCHER_MARKER));
});

test("reels doctor reads back the bundle the launcher was written for", async () => {
  const { readCliLauncher } = await import("../../src/shared/cli-launcher");
  const bundle = "/Apps/It's here/reels.mjs";
  const executable = "/Apps/Reels Dashboard.app/Contents/MacOS/Reels Dashboard";
  assert.deepEqual(readCliLauncher(cliLauncher(executable, bundle)), { executable, bundle });
  assert.equal(readCliLauncher("#!/bin/sh\necho mine\n"), undefined);
  assert.equal(readCliLauncher(`${CLI_LAUNCHER_MARKER}\nexec node x\n`), undefined);
});
