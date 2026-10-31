import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, existsSync } from "node:fs";
const git = (...args) =>
  execFileSync("git", args, { maxBuffer: 128 * 1024 * 1024 });
const mode = process.argv[2] ?? "--worktree";
const limit = 2 * 1024 * 1024,
  failures = new Set();
function inspect(file, data, size = data.length) {
  if (
    /(^|\/)(?:\.env(?:\.[^/]+)?|\.local-run|\.build|node_modules|artifacts|test-results|release|sites|\.openai|\.codex-workflows\/runs)(?:\/|$)|^AGENTS\.md$|^public\/snapshot\.json$/.test(
      file,
    )
  )
    failures.add(`${file}: private/generated path`);
  if (
    /\.(?:mov|mp4|m4v|heic|jpg|jpeg|sqlite(?:3)?|db|p12|mobileprovision|pem|key)$/i.test(
      file,
    )
  )
    failures.add(`${file}: personal media or runtime data`);
  if (size > limit) failures.add(`${file}: unexpected large file`);
  const text = data.toString("utf8");
  const patterns = [
    [
      "private home path",
      /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)(?!example[\/\\]|user[\/\\]|runner[\/\\])[^\s/\\]+[\/\\]/,
    ],
    [
      "possible secret",
      /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/,
    ],
    [
      "private briefing deployment",
      /https:\/\/(?!example\.)[a-z0-9.-]+\.chatgpt\.site\b/i,
    ],
    [
      "personal email",
      /[a-z0-9._%+-]+@(?:gmail\.com|naver\.com|daum\.net|hanmail\.net|kakao\.com|icloud\.com|outlook\.com)\b/i,
    ],
    ["personal phone", /(?<!\d)010[- .]?\d{4}[- .]?\d{4}(?!\d)/],
  ];
  for (const [label, pattern] of patterns) {
    if (
      pattern.test(
        label === "personal phone"
          ? text.replaceAll("010-1234-5678", "")
          : text,
      )
    )
      failures.add(`${file}: ${label}`);
  }
  for (const match of text.matchAll(
    /(?:signature|BYLINE_TEXT|서명)[^\n]{0,80}@([a-z0-9_.]+)/gi,
  )) {
    if (
      ![
        "your_account",
        "example",
        "demo",
        "travel_notes",
        "another_account",
        "sample",
        "a",
      ].includes(match[1])
    )
      failures.add(`${file}: personal account signature`);
  }
}
function inspectObjects(entries) {
  const objects = [...new Set(entries.map((e) => e.oid))];
  if (!objects.length) return;
  const options = {
    input: objects.join("\n") + "\n",
    maxBuffer: 128 * 1024 * 1024,
  };
  const sizes = new Map(
    execFileSync("git", ["cat-file", "--batch-check"], options)
      .toString()
      .trim()
      .split("\n")
      .map((line) => {
        const [oid, type, size] = line.split(" ");
        return [oid, { type, size: Number(size) }];
      }),
  );
  const selected = objects.filter(
    (oid) => sizes.get(oid).type === "blob" && sizes.get(oid).size <= limit,
  );
  const contents = new Map();
  if (selected.length) {
    const output = execFileSync("git", ["cat-file", "--batch"], {
      ...options,
      input: selected.join("\n") + "\n",
    });
    let offset = 0;
    for (const oid of selected) {
      offset = output.indexOf(10, offset) + 1;
      const size = sizes.get(oid).size;
      contents.set(oid, output.subarray(offset, offset + size));
      offset += size + 1;
    }
  }
  for (const { file, oid } of entries) {
    const meta = sizes.get(oid);
    if (meta.type === "blob")
      inspect(file, contents.get(oid) ?? Buffer.alloc(0), meta.size);
  }
}
let count = 0;
if (mode === "--worktree") {
  const files = new Set(
    git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
      .toString()
      .split("\0")
      .filter(Boolean),
  );
  for (const file of files) {
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (info.isSymbolicLink()) {
      failures.add(`${file}: review symlink`);
      continue;
    }
    if (!info.isFile()) continue;
    inspect(
      file,
      info.size <= limit ? readFileSync(file) : Buffer.alloc(0),
      info.size,
    );
    count++;
  }
} else if (mode === "--staged") {
  const entries = git("ls-files", "--stage", "-z")
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t"),
        file = line.slice(separator + 1);
      const [permissions, oid, stage] = line.slice(0, separator).split(" ");
      if (stage !== "0" || permissions === "120000" || permissions === "160000")
        failures.add(`${file}: unresolved index, symlink or submodule`);
      return { file, oid };
    });
  inspectObjects(entries);
  count = entries.length;
} else if (mode === "--history") {
  const refs = process.argv.slice(3);
  if (!refs.length) refs.push("--all");
  const entries = git("rev-list", "--objects", ...refs)
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.includes(" "))
    .map((line) => ({
      oid: line.slice(0, line.indexOf(" ")),
      file: line.slice(line.indexOf(" ") + 1),
    }));
  inspectObjects(entries);
  count = entries.length;
  inspect(
    "commit metadata",
    git("log", ...refs, "--format=%an <%ae>%n%cn <%ce>%n%B"),
  );
} else throw new Error("Use --worktree, --staged or --history [refs...]");
// Report categories and filenames, never the private matching value.
if (failures.size) {
  console.error([...failures].join("\n"));
  process.exit(1);
}
console.log(
  `Public source audit passed (${mode}): ${count} entries. Pattern checks do not replace media and content review.`,
);
