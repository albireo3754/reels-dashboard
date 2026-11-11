import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentStartIntent,
  menuKeyTarget,
  startChoices,
  tabKeyTarget,
  tabTooltip,
} from "../../src/features/dev-workspace/model/session-tabs";

test("tab arrows wrap, Home/End jump and other keys are ignored", () => {
  assert.equal(tabKeyTarget("ArrowRight", 2, 3), 0);
  assert.equal(tabKeyTarget("ArrowLeft", 0, 3), 2);
  assert.equal(tabKeyTarget("ArrowRight", 0, 3), 1);
  assert.equal(tabKeyTarget("Home", 2, 3), 0);
  assert.equal(tabKeyTarget("End", 0, 3), 2);
  assert.equal(tabKeyTarget("Enter", 0, 3), undefined);
  assert.equal(tabKeyTarget("ArrowRight", 0, 0), undefined);
  assert.equal(menuKeyTarget("ArrowDown", 4, 5), 0);
  assert.equal(menuKeyTarget("ArrowUp", 0, 5), 4);
  assert.equal(menuKeyTarget("a", 0, 5), undefined);
});

test("start choices follow the host's providers and keep terminal first", () => {
  const both = startChoices(
    [
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude Code" },
    ],
    false,
  );
  assert.deepEqual(
    both.map((c) => [c.kind, c.label, c.primary]),
    [
      ["shell", "터미널", true],
      ["codex", "Codex 열기", true],
      ["claude", "Claude 열기", true],
      ["preview", "미리보기 서버", false],
      ["checks", "검증 실행", false],
    ],
  );
  const codexOnly = startChoices([{ id: "codex", label: "Codex" }], true);
  assert.equal(codexOnly.some((c) => c.kind === "claude"), false);
  assert.match(codexOnly[1].detail, /요청문과 단계를 전달/);
  assert.match(both[1].detail, /대화형/);
});

test("tab tooltip carries the folder, herdr ownership and the shortcut instead of a badge", () => {
  const base = {
    id: "a",
    kind: "shell" as const,
    title: "터미널 2",
    cwd: "/repo",
    backend: "direct" as const,
    state: "running" as const,
    startedAt: "2026-11-11T00:00:00Z",
  };
  assert.equal(tabTooltip(base, "실행 중", "⌘2"), "터미널 2 · 실행 중 · /repo · ⌘2");
  assert.match(tabTooltip({ ...base, backend: "herdr" }, "실행 중"), /herdr 세션\(앱을 종료해도 유지\)$/);
  assert.match(tabTooltip({ ...base, backend: "herdr", restored: true }, "연결 끊김"), /이전 실행에서 복원한 herdr 세션/);
});

test("a written request opens the composer before an agent starts; empty requests start right away", () => {
  assert.equal(agentStartIntent("codex", true, false), "reveal");
  assert.equal(agentStartIntent("claude", true, false), "reveal");
  assert.equal(agentStartIntent("codex", true, true), "start");
  assert.equal(agentStartIntent("codex", false, false), "start");
  assert.equal(agentStartIntent("shell", true, false), "start");
  assert.equal(agentStartIntent("preview", true, false), "start");
});
