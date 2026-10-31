import { useEffect, useLayoutEffect, useRef } from "react";
import type { WorkbenchBridge } from "../../../shared/workbench";
import type { WorkbenchAction } from "./shortcuts";

export function useWorkbenchShortcuts(
  api: WorkbenchBridge,
  dispatch: (action: WorkbenchAction) => void,
) {
  const latest = useRef(dispatch);
  useLayoutEffect(() => {
    latest.current = dispatch;
  });
  useEffect(() => api.onShortcut((action) => latest.current(action)), [api]);
}
