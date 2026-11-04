import { formatKey, type KeyAction } from "../../keymap";
import { useKeymap, useShortcutsRevealed } from "./ShortcutsProvider";

/**
 * The action's key, shown over the top-left corner of the (positioned) parent
 * while ⌘ is held. Callers pass `action` only when the key would act there, so
 * holding ⌘ reveals exactly the live shortcuts. Host actions are only passed
 * where `bridge.workbench` exists, which preload exposes in dev mode only.
 */
export function ShortcutHint({
  action,
  className,
}: {
  action?: KeyAction;
  className?: string;
}) {
  const keymap = useKeymap();
  const revealed = useShortcutsRevealed();
  if (!action || !revealed) return null;
  return (
    <kbd
      data-shortcut-hint={action}
      className={className ? `shortcut-hint ${className}` : "shortcut-hint"}
      aria-hidden="true"
    >
      {formatKey(keymap[action][0])}
    </kbd>
  );
}
