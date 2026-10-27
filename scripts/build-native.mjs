import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync } from "node:fs";
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
copyFileSync(path.join(binaryDirectory, "photosindex"), destination);
chmodSync(destination, 0o755);
console.log(
  "Built native/photosindex/.build/PhotosIndex.app and .build/photosindex",
);
