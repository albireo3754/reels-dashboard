export type WorkbenchAction =
  | { type: "toggle" }
  | { type: "newTerminal" }
  | { type: "close" }
  | { type: "selectIndex"; index: number };

const commands = [
  { code: "KeyN", hint: "⌘N", action: { type: "toggle" } },
  { code: "KeyT", hint: "⌘T", action: { type: "newTerminal" } },
  { code: "KeyW", hint: "⌘W", action: { type: "close" } },
  ...Array.from({ length: 9 }, (_, index) => ({
    code: `Digit${index + 1}`,
    hint: `⌘${index + 1}`,
    action: { type: "selectIndex" as const, index },
  })),
] satisfies { code: string; hint: string; action: WorkbenchAction }[];

export function shortcutHint(type: WorkbenchAction["type"], index?: number) {
  return (
    commands.find(
      (entry) =>
        entry.action.type === type &&
        (entry.action.type !== "selectIndex" || entry.action.index === index),
    )?.hint ?? ""
  );
}

export function matchWorkbenchShortcut(event: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}): WorkbenchAction | undefined {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    !event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  )
    return;
  const code = /^Numpad[1-9]$/.test(event.code)
    ? event.code.replace("Numpad", "Digit")
    : event.code;
  return commands.find((entry) => entry.code === code)?.action;
}
