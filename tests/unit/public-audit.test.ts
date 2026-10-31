import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const script = resolve("scripts/audit-public.mjs");
test("publication audit checks staged blobs and ancestors, without printing sensitive values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "publication-audit-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  const audit = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  const privateValue = ["/Users", "private-audit-person", "document"].join("/");
  try {
    git("init");
    git("config", "user.name", "Audit Test");
    git("config", "user.email", "audit@example.com");
    writeFileSync(join(cwd, "file.txt"), privateValue);
    git("add", "file.txt");
    writeFileSync(join(cwd, "file.txt"), "clean worktree");
    assert.equal(audit("--worktree").status, 0);
    const staged = audit("--staged");
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /private home path/);
    assert.ok(!staged.stderr.includes(privateValue));
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
    git("add", "file.txt");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "clean current file");
    assert.equal(audit("--staged").status, 0);
    assert.equal(audit("--history", "HEAD").status, 1);
    writeFileSync(join(cwd, "credential.txt"), "github_pat_" + "z".repeat(40));
    assert.equal(audit("--worktree").status, 1);
    rmSync(join(cwd, "credential.txt"));
    writeFileSync(join(cwd, "snapshot.db"), "fixture");
    assert.equal(audit("--worktree").status, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
