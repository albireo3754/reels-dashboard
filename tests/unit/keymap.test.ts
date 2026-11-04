import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KEYMAP,
  HOST_ACTIONS,
  KEY_ACTIONS,
  MODE_ACTIONS,
  formatKey,
  goToTab,
  matchAction,
  parseKey,
  sameCombo,
  tabIndex,
  type KeyAction,
} from "../../src/shared/keymap";

const key = (
  code: string,
  mods: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    isComposing: boolean;
    keyCode: number;
  }> = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...mods,
});
const cmd = (code: string, mods: Parameters<typeof key>[1] = {}) =>
  key(code, { metaKey: true, ...mods });
const km = DEFAULT_KEYMAP;
const allActions = [
  ...Object.keys(KEY_ACTIONS),
  ...Object.keys(MODE_ACTIONS),
] as KeyAction[];

test("every default parses and no two defaults conflict", () => {
  for (const [action, value] of Object.entries(KEY_ACTIONS))
    for (const s of typeof value === "string" ? [value] : value)
      assert.doesNotThrow(() => parseKey(s), action);
  for (const value of Object.values(MODE_ACTIONS))
    assert.doesNotThrow(() => parseKey(value, true));
  const combos = allActions.flatMap((action) =>
    km[action].map((combo) => ({ action, combo })),
  );
  combos.forEach((a, i) =>
    combos.slice(i + 1).forEach((b) => {
      assert.ok(!sameCombo(a.combo, b.combo), `${a.action} vs ${b.action}`);
    }),
  );
  assert.ok(Object.isFrozen(DEFAULT_KEYMAP));
  assert.ok(Object.isFrozen(DEFAULT_KEYMAP.quickOpen));
});

test("parseKey accepts modifier aliases, spaces and any case", () => {
  assert.deepEqual(parseKey("Cmd+N"), {
    code: "KeyN",
    meta: true,
    ctrl: false,
    alt: false,
    shift: false,
  });
  assert.deepEqual(parseKey(" command + shift + [ "), {
    code: "BracketLeft",
    meta: true,
    ctrl: false,
    alt: false,
    shift: true,
  });
  assert.deepEqual(parseKey("Ctrl+Alt+1"), {
    code: "Digit1",
    meta: false,
    ctrl: true,
    alt: true,
    shift: false,
  });
  assert.deepEqual(parseKey("cMd+n"), parseKey("CMD+N"));
  assert.deepEqual(parseKey("meta+option+]"), parseKey("Cmd+Opt+]"));
  assert.deepEqual(parseKey("control+K"), parseKey("Ctrl+K"));
});

test("parseKey rejects malformed, unknown and bare bindings", () => {
  for (const s of [
    "",
    "N",
    "Shift+N",
    "Cmd+",
    "Cmd+Foo",
    "Hyper+N",
    "Cmd+Cmd+N",
    "Cmd+N+T",
    "Cmd+ㅜ",
  ])
    assert.throws(() => parseKey(s), Error, JSON.stringify(s));
});

test("a bare key binds only the exitInspect mode action", () => {
  assert.deepEqual(parseKey("Esc", true), {
    code: "Escape",
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
  });
  assert.throws(() => parseKey("Escape"));
  assert.deepEqual(Object.keys(MODE_ACTIONS), ["exitInspect"]);
  assert.equal(matchAction(km, key("Escape")), "exitInspect");
  assert.equal(matchAction(km, key("Escape"), "renderer"), "exitInspect");
  assert.equal(matchAction(km, key("Escape"), "host"), undefined);
  assert.equal(formatKey(km.exitInspect[0]), "Esc");
});

test("matchAction needs the exact modifiers and normalises keypad digits", () => {
  assert.equal(matchAction(km, cmd("KeyN")), "toggleDrawer");
  assert.equal(matchAction(km, cmd("KeyT")), "newTerminal");
  assert.equal(matchAction(km, cmd("KeyW")), "closeTab");
  assert.equal(matchAction(km, cmd("KeyN", { shiftKey: true })), undefined);
  assert.equal(matchAction(km, key("KeyN", { ctrlKey: true })), undefined);
  for (const field of ["ctrlKey", "altKey", "shiftKey"] as const)
    assert.equal(matchAction(km, cmd("KeyN", { [field]: true })), undefined);
  assert.equal(matchAction(km, key("KeyN")), undefined);
  assert.equal(matchAction(km, cmd("Digit0")), undefined);
  assert.equal(matchAction(km, cmd("Numpad3")), "goToTab3");
  for (let n = 1; n <= 9; n++) {
    assert.equal(matchAction(km, cmd(`Digit${n}`)), goToTab(n));
    assert.equal(matchAction(km, cmd(`Numpad${n}`), "host"), goToTab(n));
  }
});

test("host matcher input without keyCode leaves app accelerators alone", () => {
  for (const code of ["KeyQ", "KeyC", "KeyV", "KeyR", "Numpad0"])
    assert.equal(matchAction(km, cmd(code), "host"), undefined);
  assert.equal(matchAction(km, cmd("KeyK"), "host"), undefined);
});

test("shift is accepted only for inspectUi", () => {
  assert.equal(matchAction(km, cmd("KeyC", { shiftKey: true })), "inspectUi");
  assert.equal(
    matchAction(km, cmd("KeyC", { shiftKey: true }), "host"),
    "inspectUi",
  );
  assert.equal(matchAction(km, cmd("KeyN", { shiftKey: true })), undefined);
  assert.equal(
    matchAction(km, key("KeyC", { shiftKey: true })),
    undefined,
    "no Cmd",
  );
  assert.equal(matchAction(km, cmd("KeyK", { shiftKey: true })), undefined);
  for (const action of allActions)
    for (const combo of km[action])
      assert.equal(combo.shift, action === "inspectUi", action);
});

test("Cmd+K and Ctrl+K both open quick search, in renderer scope only", () => {
  assert.equal(matchAction(km, cmd("KeyK")), "quickOpen");
  assert.equal(matchAction(km, key("KeyK", { ctrlKey: true })), "quickOpen");
  assert.equal(
    matchAction(km, key("KeyK", { ctrlKey: true }), "renderer"),
    "quickOpen",
  );
  assert.equal(
    matchAction(km, key("KeyK", { ctrlKey: true, metaKey: true })),
    undefined,
  );
  assert.equal(matchAction(km, cmd("KeyN"), "renderer"), undefined);
});

test("Cmd+[ and Cmd+] step history back and forward, in renderer scope only", () => {
  assert.equal(matchAction(km, cmd("BracketLeft"), "renderer"), "goBack");
  assert.equal(matchAction(km, cmd("BracketRight"), "renderer"), "goForward");
  assert.equal(matchAction(km, cmd("BracketLeft"), "host"), undefined);
  assert.equal(matchAction(km, cmd("BracketLeft", { shiftKey: true })), undefined);
  assert.ok(!(HOST_ACTIONS as readonly string[]).includes("goBack"));
  assert.ok(!(HOST_ACTIONS as readonly string[]).includes("goForward"));
  assert.equal(formatKey(km.goBack[0]), "⌘[");
  assert.equal(formatKey(km.goForward[0]), "⌘]");
});

test("IME composition and keyCode 229 never match", () => {
  for (const event of [cmd("KeyN"), cmd("KeyC", { shiftKey: true }), cmd("KeyK")]) {
    assert.equal(matchAction(km, { ...event, isComposing: true }), undefined);
    assert.equal(matchAction(km, { ...event, keyCode: 229 }), undefined);
  }
  assert.equal(matchAction(km, { ...cmd("KeyN"), keyCode: 78 }), "toggleDrawer");
});

test("formatKey prints macOS modifier order and today's host hints", () => {
  assert.equal(formatKey(parseKey("Cmd+N")), "⌘N");
  assert.equal(formatKey(parseKey("Cmd+Shift+Ctrl+Alt+1")), "⌃⌥⇧⌘1");
  assert.equal(formatKey(parseKey("Alt+[")), "⌥[");
  assert.equal(formatKey(km.toggleDrawer[0]), "⌘N");
  assert.equal(formatKey(km.newTerminal[0]), "⌘T");
  assert.equal(formatKey(km.closeTab[0]), "⌘W");
  for (let n = 1; n <= 9; n++)
    assert.equal(formatKey(km[goToTab(n)!][0]), `⌘${n}`);
  // macOS menu order puts ⇧ before ⌘ (the old hard-coded hint said "⌘⇧C").
  assert.equal(formatKey(km.inspectUi[0]), "⇧⌘C");
  assert.deepEqual(km.quickOpen.map(formatKey), ["⌘K", "⌃K"]);
});

test("goToTab inverts tabIndex for 1…9 only; other actions have no index", () => {
  for (let n = 1; n <= 9; n++) assert.equal(tabIndex(goToTab(n)!), n);
  for (const n of [0, 10, 1.5, -1]) assert.equal(goToTab(n), undefined);
  assert.equal(tabIndex("closeTab"), undefined);
  assert.deepEqual(
    [...HOST_ACTIONS],
    [
      "toggleDrawer",
      "newTerminal",
      "closeTab",
      ...Array.from({ length: 9 }, (_, i) => goToTab(i + 1)),
      "inspectUi",
    ],
  );
});
