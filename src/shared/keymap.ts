// One central keymap for every app shortcut: the Electron host matcher, the
// renderer dispatcher and every visible hint read the same table. Pure TS — no
// Electron, React or Node imports — so main, preload, renderer and tests share it.

/** Default bindings in dispatch priority order: on a conflict the earlier entry wins. */
export const KEY_ACTIONS = {
  toggleDrawer: "Cmd+N",
  newTerminal: "Cmd+T",
  closeTab: "Cmd+W",
  goToTab1: "Cmd+1",
  goToTab2: "Cmd+2",
  goToTab3: "Cmd+3",
  goToTab4: "Cmd+4",
  goToTab5: "Cmd+5",
  goToTab6: "Cmd+6",
  goToTab7: "Cmd+7",
  goToTab8: "Cmd+8",
  goToTab9: "Cmd+9",
  inspectUi: "Cmd+Shift+C",
  quickOpen: ["Cmd+K", "Ctrl+K"],
  goBack: "Cmd+[",
  goForward: "Cmd+]",
} as const satisfies Record<string, string | readonly string[]>;

/**
 * Actions that are live only while their mode is on (the key passes through
 * otherwise), so they are the only ones allowed to bind a bare key.
 */
export const MODE_ACTIONS = {
  exitInspect: "Escape",
} as const satisfies Record<string, string | readonly string[]>;

export type KeyAction = keyof typeof KEY_ACTIONS | keyof typeof MODE_ACTIONS;
export interface KeyCombo {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}
export type Keymap = Readonly<Record<KeyAction, readonly KeyCombo[]>>;
export type ShortcutScope = "host" | "renderer";

/**
 * Actions the Electron host matches in `before-input-event` and sends over the
 * `workbench:shortcut` IPC. Every other action is renderer scope.
 */
export const HOST_ACTIONS = Object.freeze([
  "toggleDrawer",
  "newTerminal",
  "closeTab",
  "goToTab1",
  "goToTab2",
  "goToTab3",
  "goToTab4",
  "goToTab5",
  "goToTab6",
  "goToTab7",
  "goToTab8",
  "goToTab9",
  "inspectUi",
] as const satisfies readonly KeyAction[]);

const ACTIONS = [
  ...Object.keys(KEY_ACTIONS),
  ...Object.keys(MODE_ACTIONS),
] as KeyAction[];
const MODE_KEYS: readonly string[] = Object.keys(MODE_ACTIONS);
const HOST_KEYS: readonly string[] = HOST_ACTIONS;

export const isModeAction = (action: KeyAction) => MODE_KEYS.includes(action);
export const isHostAction = (action: KeyAction) => HOST_KEYS.includes(action);

const MODIFIERS: Record<string, "meta" | "ctrl" | "alt" | "shift"> = {
  cmd: "meta",
  command: "meta",
  meta: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};
const PUNCTUATION: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
};

const keyCode = (key: string): string | undefined =>
  key === "esc" || key === "escape"
    ? "Escape"
    : /^[a-z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : PUNCTUATION[key];

/**
 * "Cmd+Shift+C" → a physical-key (`KeyboardEvent.code`) combo. A binding needs
 * Cmd, Ctrl or Alt so it never takes plain typing from a terminal or a form,
 * unless `bare` (a MODE_ACTIONS binding). Throws on anything it cannot parse.
 */
export function parseKey(input: string, bare = false): KeyCombo {
  const parts = input.split("+").map((part) => part.trim().toLowerCase());
  if (parts.some((part) => !part))
    throw new Error(`Empty key part in "${input}"`);
  const last = parts.pop()!;
  const combo: KeyCombo = {
    code: "",
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
  };
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (!modifier)
      throw new Error(
        keyCode(part)
          ? `More than one key in "${input}"`
          : `Unknown modifier "${part}" in "${input}"`,
      );
    if (combo[modifier])
      throw new Error(`Duplicate modifier "${part}" in "${input}"`);
    combo[modifier] = true;
  }
  const code = keyCode(last);
  if (!code) throw new Error(`Unknown key "${last}" in "${input}"`);
  combo.code = code;
  if (!bare && !combo.meta && !combo.ctrl && !combo.alt)
    throw new Error(`"${input}" needs Cmd, Ctrl or Alt`);
  return combo;
}

const bindings = (value: string | readonly string[]): readonly string[] =>
  typeof value === "string" ? [value] : value;

function buildDefaultKeymap(): Keymap {
  const entries = ACTIONS.map((action) => {
    const mode = isModeAction(action);
    const raw = mode
      ? MODE_ACTIONS[action as keyof typeof MODE_ACTIONS]
      : KEY_ACTIONS[action as keyof typeof KEY_ACTIONS];
    return [
      action,
      Object.freeze(
        bindings(raw).map((key) => Object.freeze(parseKey(key, mode))),
      ),
    ] as const;
  });
  return Object.freeze(Object.fromEntries(entries) as Keymap);
}

/** Module-level frozen constant, so a context value holding it stays stable. */
export const DEFAULT_KEYMAP: Keymap = buildDefaultKeymap();

export interface KeyInput {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export const sameCombo = (a: KeyCombo, b: KeyCombo) =>
  a.code === b.code &&
  a.meta === b.meta &&
  a.ctrl === b.ctrl &&
  a.alt === b.alt &&
  a.shift === b.shift;

/**
 * The first action (KEY_ACTIONS then MODE_ACTIONS order) whose combo matches
 * exactly, optionally restricted to one scope. Keypad digits count as the digit
 * row. IME composition (including Chromium's keyCode 229) never matches.
 */
export function matchAction(
  keymap: Keymap,
  event: KeyInput,
  scope?: ShortcutScope,
): KeyAction | undefined {
  if (event.isComposing || event.keyCode === 229) return;
  const pressed: KeyCombo = {
    code: event.code.replace(/^Numpad([1-9])$/, "Digit$1"),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
  return ACTIONS.find(
    (action) =>
      (!scope || isHostAction(action) === (scope === "host")) &&
      keymap[action].some((combo) => sameCombo(combo, pressed)),
  );
}

/** 'goToTab3' → 3; other actions → undefined. */
export function tabIndex(action: KeyAction): number | undefined {
  const match = /^goToTab([1-9])$/.exec(action);
  return match ? Number(match[1]) : undefined;
}

/** 3 → 'goToTab3'; outside 1…9 → undefined. The inverse of tabIndex. */
export function goToTab(n: number): KeyAction | undefined {
  return Number.isInteger(n) && n >= 1 && n <= 9
    ? (`goToTab${n}` as KeyAction)
    : undefined;
}

const GLYPH: Record<string, string> = {
  Escape: "Esc",
  BracketLeft: "[",
  BracketRight: "]",
};

/** { meta, shift, code: 'KeyC' } → '⇧⌘C', modifiers in macOS menu order (⌃⌥⇧⌘). */
export function formatKey(combo: KeyCombo): string {
  const key = GLYPH[combo.code] ?? combo.code.replace(/^(Key|Digit)/, "");
  return `${combo.ctrl ? "⌃" : ""}${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${combo.meta ? "⌘" : ""}${key}`;
}
