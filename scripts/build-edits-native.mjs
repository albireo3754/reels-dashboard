import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  renameSync,
  rmSync,
  constants,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function developerIdentity(output, requested) {
  const identities = new Map();
  for (const match of output.matchAll(
    /\b([A-Fa-f0-9]{40})\s+"(Developer ID Application:[^"]+)"/g,
  ))
    if (!requested || match[2] === requested)
      identities.set(match[1], match[2]);
  if (identities.size !== 1)
    throw new Error(
      `Expected one Developer ID Application identity; found ${identities.size}. No ad-hoc fallback.`,
    );
  return [...identities.keys()][0];
}

// Match PhotosIndex's disposable-CI signing contract. Never silently downgrade a
// local/production build when a Developer ID certificate is missing.
export function signingIdentity(env, identities) {
  const mode = env.PHOTOSINDEX_SIGNING_MODE ?? "developer-id";
  if (mode === "ci-adhoc") {
    if (env.CI !== "true")
      throw new Error("ci-adhoc signing requires disposable CI artifacts (CI=true)");
    return "-";
  }
  if (mode !== "developer-id")
    throw new Error(`Unsupported PHOTOSINDEX_SIGNING_MODE '${mode}'`);
  return developerIdentity(
    identities(),
    env.EDITSAX_SIGNING_IDENTITY ?? env.PHOTOSINDEX_SIGNING_IDENTITY,
  );
}

export function buildEditsNative() {
  if (process.platform !== "darwin") throw new Error("Edits AX requires macOS");
  const identity = signingIdentity(process.env, () =>
    execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8" },
    ),
  );
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const native = path.join(repo, "native/editsax");
  execFileSync(
    "/usr/bin/swift",
    ["build", "-c", "release", "--product", "editsax"],
    { cwd: native, stdio: "inherit" },
  );
  const bin = execFileSync(
    "/usr/bin/swift",
    ["build", "-c", "release", "--show-bin-path"],
    { cwd: native, encoding: "utf8" },
  ).trim();
  const staged = path.join(native, ".build", `.editsax-stage-${randomUUID()}`);
  try {
    copyFileSync(path.join(bin, "editsax"), staged, constants.COPYFILE_EXCL);
    chmodSync(staged, 0o755);
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--options",
        "runtime",
        "--identifier",
        "io.github.reelsdashboard.editsax",
        "--sign",
        identity,
        staged,
      ],
      { stdio: "inherit" },
    );
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", staged], {
      stdio: "inherit",
    });
    renameSync(staged, path.join(native, ".build/editsax"));
  } finally {
    rmSync(staged, { force: true });
  }
  console.log(
    "Built signed native/editsax/.build/editsax; no permission prompts or app launch",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  buildEditsNative();
