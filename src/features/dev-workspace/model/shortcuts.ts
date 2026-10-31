export type DrawerMode = "closed" | "open" | "folded";
export {
  matchWorkbenchShortcut,
  shortcutHint,
  type WorkbenchAction,
} from "../../../shared/workbench-shortcuts";

export function toggleDrawer(mode: DrawerMode): DrawerMode {
  return mode === "open" ? "folded" : "open";
}

export function reconcileSelection(
  previous: readonly string[],
  next: readonly string[],
  selected: string,
): string {
  if (next.includes(selected)) return selected;
  const index = previous.indexOf(selected);
  if (index >= 0) {
    const neighbor = [
      ...previous.slice(index + 1),
      ...previous.slice(0, index).reverse(),
    ].find((id) => next.includes(id));
    if (neighbor) return neighbor;
  }
  return next.at(-1) ?? "";
}
