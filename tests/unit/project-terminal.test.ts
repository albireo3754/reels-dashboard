import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { projectWorkPrompt } from "../../src/shared/workbench";
import { terminalCommand } from "../../src/desktop/workbench";

test("project terminal carries exact identity and content request as one quoted argument", () => {
  const project = {
    id: "content-a",
    title: "카페 '하루' $(echo hidden)",
    resources: ["/private/media"],
    localNotes: "private note",
  };
  const task = "자막 '간격' 수정 $(echo hidden)\n다음 줄";
  const command = terminalCommand({
    kind: "codex",
    project: { id: project.id, title: project.title },
    task,
  })!;
  // Replace only the executable to inspect the arguments through a real shell.
  const args = JSON.parse(
    execFileSync(
      "/bin/sh",
      [
        "-c",
        command.replace(
          "exec 'codex'",
          "exec /usr/bin/python3 -c 'import sys,json;print(json.dumps(sys.argv[1:]))'",
        ),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(args.at(-1), projectWorkPrompt(project, task));
  assert.match(args.at(-1), /콘텐츠 프로젝트 작업/);
  assert.match(args.at(-1), /reels_get_content/);
  assert.doesNotMatch(
    args.at(-1),
    /Reels Dashboard 개발 작업|private note|private\/media/,
  );
  assert.ok(args.includes("workspace-write"));
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("opening without a request waits for instructions and development requests retain their scope", () => {
  assert.match(
    terminalCommand({ kind: "codex", project: { id: "a", title: "A" } })!,
    /아직 수정하지 마세요/,
  );
  assert.match(
    terminalCommand({ kind: "codex", task: "앱 수정" })!,
    /Reels Dashboard 개발 작업/,
  );
});

test("host rejects invalid project context and non-agent or read-only phase combinations", () => {
  for (const project of [
    { id: "", title: "A" },
    { id: "a", title: "bad\x1b" },
    { id: "a", title: "x".repeat(501) },
  ]) {
    assert.throws(() => terminalCommand({ kind: "codex", project }));
  }
  const project = { id: "a", title: "A" };
  for (const kind of ["shell", "preview", "checks"] as const)
    assert.throws(() => terminalCommand({ kind, project }));
  assert.throws(() =>
    terminalCommand({ kind: "codex", phase: "review", project }),
  );
});
