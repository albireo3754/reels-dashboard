import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchWorkbenchShortcut,
  reconcileSelection,
  shortcutHint,
  toggleDrawer,
} from "../../src/features/dev-workspace/model/shortcuts";

const key = {
  code: "KeyN",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 78,
};

test("drawer shortcuts use physical keys, exact modifiers and skip IME composition", () => {
  assert.deepEqual(matchWorkbenchShortcut(key), { type: "toggle" });
  assert.deepEqual(matchWorkbenchShortcut({ ...key, code: "KeyT" }), {
    type: "newTerminal",
  });
  assert.deepEqual(matchWorkbenchShortcut({ ...key, code: "KeyW" }), {
    type: "close",
  });
  for (const field of ["ctrlKey", "altKey", "shiftKey", "isComposing"] as const)
    assert.equal(matchWorkbenchShortcut({ ...key, [field]: true }), undefined);
  assert.equal(matchWorkbenchShortcut({ ...key, keyCode: 229 }), undefined);
  assert.equal(matchWorkbenchShortcut({ ...key, metaKey: false }), undefined);
  assert.equal(matchWorkbenchShortcut({ ...key, code: "Digit0" }), undefined);
  for (let index = 0; index < 9; index++) {
    assert.deepEqual(
      matchWorkbenchShortcut({ ...key, code: `Digit${index + 1}` }),
      { type: "selectIndex", index },
    );
    assert.equal(shortcutHint("selectIndex", index), `⌘${index + 1}`);
  }
});

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
