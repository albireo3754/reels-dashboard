import { test } from "node:test";
import assert from "node:assert/strict";
import { workbenchShortcutTarget } from "../../src/features/dev-workspace/model/shortcut-target";

const sessions = ["a", "b", "c"];

test("drawer closed: Cmd 1-9 navigates screens and Cmd W hides the window", () => {
  const drawer = { mode: "closed" as const, sessions, selected: "b", screens: 7 };
  assert.deepEqual(workbenchShortcutTarget(drawer, "goToTab1"), { kind: "screen", index: 0 });
  assert.deepEqual(workbenchShortcutTarget(drawer, "goToTab7"), { kind: "screen", index: 6 });
  assert.deepEqual(workbenchShortcutTarget(drawer, "closeTab"), { kind: "hideWindow" });
  // App does not see the sessions; screen targets must not depend on them.
  assert.deepEqual(workbenchShortcutTarget({ mode: "closed", screens: 7 }, "goToTab2"), { kind: "screen", index: 1 });
});

test("drawer open: Cmd 1-9 selects a session tab and Cmd W closes the selected one", () => {
  const drawer = { mode: "open" as const, sessions, selected: "b", screens: 7 };
  assert.deepEqual(workbenchShortcutTarget(drawer, "goToTab1"), { kind: "session", id: "a" });
  assert.deepEqual(workbenchShortcutTarget(drawer, "goToTab3"), { kind: "session", id: "c" });
  assert.deepEqual(workbenchShortcutTarget(drawer, "closeTab"), { kind: "session", id: "b" });
  assert.equal(workbenchShortcutTarget({ mode: "open", screens: 7 }, "goToTab1"), undefined);
});

test("drawer folded acts like closed for Cmd 1-9 and Cmd W", () => {
  const drawer = { mode: "folded" as const, sessions, selected: "a", screens: 7 };
  assert.deepEqual(workbenchShortcutTarget(drawer, "goToTab3"), { kind: "screen", index: 2 });
  assert.deepEqual(workbenchShortcutTarget(drawer, "closeTab"), { kind: "hideWindow" });
});

test("Cmd W with no session closes the open drawer", () => {
  assert.deepEqual(
    workbenchShortcutTarget({ mode: "open", sessions: [], selected: "", screens: 7 }, "closeTab"),
    { kind: "closeDrawer" },
  );
  assert.deepEqual(workbenchShortcutTarget({ mode: "open", screens: 7 }, "closeTab"), { kind: "closeDrawer" });
});

test("an index out of range, other actions and no action have no target", () => {
  assert.equal(workbenchShortcutTarget({ mode: "closed", sessions, selected: "", screens: 7 }, "goToTab8"), undefined);
  assert.equal(workbenchShortcutTarget({ mode: "closed", screens: 0 }, "goToTab1"), undefined);
  assert.equal(workbenchShortcutTarget({ mode: "open", sessions, selected: "a", screens: 7 }, "goToTab4"), undefined);
  assert.equal(workbenchShortcutTarget({ mode: "open", sessions, selected: "a", screens: 7 }, "goToTab9"), undefined);
  for (const action of ["toggleDrawer", "newTerminal", "inspectUi", "quickOpen", "exitInspect"] as const)
    assert.equal(workbenchShortcutTarget({ mode: "open", sessions, selected: "a", screens: 7 }, action), undefined);
  assert.equal(workbenchShortcutTarget({ mode: "open", sessions, selected: "a", screens: 7 }, undefined), undefined);
});
