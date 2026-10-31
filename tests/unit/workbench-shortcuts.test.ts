import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWorkbenchShortcut } from "../../src/shared/workbench-shortcuts";

test("native shortcut input without keyCode shares number selection and leaves app accelerators alone", () => {
  const input = {
    code: "KeyW",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
  };
  assert.deepEqual(matchWorkbenchShortcut(input), { type: "close" });
  for (let index = 0; index < 9; index++) {
    assert.deepEqual(matchWorkbenchShortcut({ ...input, code: `Numpad${index + 1}` }), {
      type: "selectIndex", index,
    });
  }
  for (const code of ["KeyQ", "KeyC", "KeyV", "KeyR", "Numpad0"])
    assert.equal(matchWorkbenchShortcut({ ...input, code }), undefined);
});
