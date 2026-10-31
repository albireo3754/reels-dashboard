import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = path.join(repo, "native/photosindex");
const root = mkdtempSync(path.join(tmpdir(), "reels-signing-continuity-"));
const requirements = [];
const hashes = [];
try {
  for (const version of [1, 2]) {
    const app = path.join(root, `v${version}`, "PhotosIndex.app");
    const binary = path.join(app, "Contents/MacOS/PhotosIndex");
    mkdirSync(path.dirname(binary), { recursive: true });
    copyFileSync(path.join(native, "AppBundle/Info.plist"), path.join(app, "Contents/Info.plist"));
    const source = path.join(root, `v${version}.c`);
    writeFileSync(source, `int main(void) { return ${version}; }\n`);
    execFileSync("xcrun", ["clang", source, "-o", binary], { stdio: "pipe" });
    execFileSync("zsh", [path.join(native, "scripts/sign-app.sh"), app, path.join(native, "AppBundle/PhotosIndex.entitlements")], { stdio: "pipe" });
    const result = spawnSync("codesign", ["-d", "-r-", app], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const dr = (result.stdout + result.stderr).split("\n").find(line => line.startsWith("designated => "))?.slice("designated => ".length);
    assert.ok(dr, "Signed app must have a designated requirement");
    assert.match(dr, /anchor apple generic/);
    assert.doesNotMatch(dr, /cdhash/);
    requirements.push(dr);
    hashes.push(createHash("sha256").update(readFileSync(binary)).digest("hex"));
    execFileSync("codesign", ["--verify", "--strict", "-R", "=" + requirements[0], app], { stdio: "pipe" });
  }
  assert.notEqual(hashes[0], hashes[1], "Different builds must change executable bytes");
  assert.equal(requirements[0], requirements[1], "Different builds must preserve their designated requirement");
  console.log("Developer ID continuity passed: two different signed executables satisfy the same designated requirement. No Photos access requested.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
