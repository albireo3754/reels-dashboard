import { lazy } from "react";

/**
 * Loaded on demand (xterm and the drawer stay in their own chunk), so App can
 * import this slice's pure rule statically without pulling the UI in.
 */
export const DevWorkspace = lazy(() =>
  import("./ui/DevWorkspace").then((m) => ({ default: m.DevWorkspace })),
);
export type { DrawerMode } from "./model/drawer";
export {
  workbenchShortcutTarget,
  type WorkbenchDrawerState,
  type WorkbenchShortcutTarget,
} from "./model/shortcut-target";
