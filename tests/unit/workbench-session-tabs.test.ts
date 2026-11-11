import { test } from "node:test";
import assert from "node:assert/strict";
import {
  menuKeyTarget,
  startChoices,
  tabKeyTarget,
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
