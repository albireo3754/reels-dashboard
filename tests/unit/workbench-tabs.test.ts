import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileSelection,
  toggleDrawer,
} from "../../src/features/dev-workspace/model/drawer";

test("drawer toggles preserve sessions and selection chooses nearest surviving tab", () => {
  assert.equal(toggleDrawer("closed"), "open");
  assert.equal(toggleDrawer("open"), "folded");
  assert.equal(toggleDrawer("folded"), "open");
  assert.equal(reconcileSelection(["a", "b", "c"], ["a", "c"], "b"), "c");
  assert.equal(reconcileSelection(["a", "b", "c"], ["a", "b"], "c"), "b");
  assert.equal(reconcileSelection(["a", "b"], ["b"], "b"), "b");
  assert.equal(reconcileSelection(["a"], [], "a"), "");
  assert.equal(reconcileSelection([], ["a"], ""), "a");
});
