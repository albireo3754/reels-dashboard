import test from "node:test";
import assert from "node:assert/strict";
import {
  visit,
  type Navigation,
} from "../../src/features/workspace-shell/navigation";

test("navigation keeps back/forward history, truncates a new branch and bounds memory", () => {
  let state: Navigation<string> = { entries: ["dashboard"], index: 0 };
  state = visit(state, "editor");
  state = visit(state, "settings");
  assert.equal(visit(state, "settings"), state);
  state = visit({ ...state, index: 1 }, "library");
  assert.deepEqual(state, {
    entries: ["dashboard", "editor", "library"],
    index: 2,
  });
  for (let i = 0; i < 60; i++) state = visit(state, `screen-${i}`);
  assert.equal(state.entries.length, 30);
  assert.equal(state.index, 29);
  assert.equal(state.entries[29], "screen-59");
});
