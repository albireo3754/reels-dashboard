import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, renameSync, rmSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "darwin") {
  throw new Error("The PhotosIndex helper requires macOS 14+ and Swift 6.");
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = path.join(repo, "native", "photosindex");
execFileSync("/bin/zsh", [path.join(native, "scripts", "build-app.sh")], {
  cwd: native,
  env: process.env,
  stdio: "inherit",
});
const binaryDirectory = execFileSync(
  "/usr/bin/swift",
  ["build", "-c", "release", "--show-bin-path"],
  {
    cwd: native,
    encoding: "utf8",
  },
).trim();
const destination = path.join(native, ".build", "photosindex");
// A signed Mach-O must never be overwritten in place: macOS can retain a
// signature/vnode cache for a running or previously executed binary.
const staged = path.join(native, ".build", `.photosindex-stage-${randomUUID()}`);
try {
  copyFileSync(path.join(binaryDirectory, "photosindex"), staged, constants.COPYFILE_EXCL);
  chmodSync(staged, 0o755);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", staged], { stdio: "inherit" });
  renameSync(staged, destination);
} finally {
  rmSync(staged, { force: true });
}
console.log(
  "Built native/photosindex/.build/PhotosIndex.app and .build/photosindex",
);
