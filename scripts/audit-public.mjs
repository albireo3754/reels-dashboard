import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const failures = [];
for (const file of new Set(files)) {
  if (
    /(^|\/)(\.env(?:\.[^/]+)?|\.local-run|\.build|node_modules|artifacts|test-results|release|\.codex-workflows\/runs)(\/|$)/.test(
      file,
    )
  ) {
    failures.push(`${file}: private/generated path`);
    continue;
  }
  const stat = statSync(file);
  if (!stat.isFile()) continue;
  if (stat.size > 2 * 1024 * 1024) {
    failures.push(`${file}: unexpected large file`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(text))
    failures.push(`${file}: private home path`);
  if (
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-proj-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/.test(
      text,
    )
  )
    failures.push(`${file}: possible secret`);
  if (/\.(?:mov|mp4|heic|jpg|jpeg|sqlite|db|p12|mobileprovision)$/i.test(file))
    failures.push(`${file}: personal media or runtime data`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Public source audit passed: ${new Set(files).size} files, no private home paths, credential patterns, runtime databases, or media.`,
);
