import { tabIndex, type KeyAction } from "../../../shared/keymap";
import type { DrawerMode } from "./drawer";

/** The drawer facts ⌘1-9 and ⌘W read. Callers that cannot see the sessions (App) omit them. */
export interface WorkbenchDrawerState {
  mode: DrawerMode;
  /** Session ids in tab order. */
  sessions?: readonly string[];
  /** The selected session id, or "" when none is selected. */
  selected?: string;
  /** How many screens the sidebar renders (⌘1-9 navigates them while the drawer is not open). */
  screens: number;
}

export type WorkbenchShortcutTarget =
  | { kind: "screen"; index: number }
  | { kind: "session"; id: string }
  | { kind: "closeDrawer" }
  | { kind: "hideWindow" }
  | undefined;

/**
 * What ⌘1-9 and ⌘W act on. The single rule both the shortcut handlers and the
 * ⌘-hold hints call, so a hint is shown exactly where the key would act:
 *
 * - ⌘N: while the drawer is not open, the Nth screen; while open, the Nth session tab.
 * - ⌘W: while not open, hide the window; while open, close the selected session,
 *   or close the drawer when no session is selected.
 *
 * Other actions (and a ⌘N past the last screen or tab) return undefined.
 */
export function workbenchShortcutTarget(
  drawer: WorkbenchDrawerState,
  action: KeyAction | undefined,
): WorkbenchShortcutTarget {
  if (!action) return;
  const open = drawer.mode === "open";
  const tab = tabIndex(action);
  if (tab !== undefined) {
    const index = tab - 1;
    if (!open) return index < drawer.screens ? { kind: "screen", index } : undefined;
    const id = drawer.sessions?.[index];
    return id ? { kind: "session", id } : undefined;
  }
  if (action !== "closeTab") return;
  if (!open) return { kind: "hideWindow" };
  return drawer.selected ? { kind: "session", id: drawer.selected } : { kind: "closeDrawer" };
}
