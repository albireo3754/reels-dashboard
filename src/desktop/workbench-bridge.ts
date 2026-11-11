import type { KeyAction } from "../shared/keymap";
import type { WorkbenchBridge } from "../shared/workbench";

/** The slice of Electron's ipcRenderer the bridge uses, so tests can pass a fake. */
export interface WorkbenchIpc {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, value: unknown) => void,
  ): unknown;
}

/** The WorkbenchBridge of the dashboard preload (window.reels.workbench), kept apart so tests can pass a fake ipc. */
export function createWorkbenchBridge(ipc: WorkbenchIpc): WorkbenchBridge {
  const invoke = (name: string, ...args: unknown[]) =>
    ipc.invoke(`reels:${name}`, ...args);
  const subscribe = (name: string, callback: (value: any) => void) => {
    const listener = (_event: unknown, value: unknown) => callback(value);
    ipc.on(name, listener);
    return () => {
      ipc.removeListener(name, listener);
    };
  };
  return {
    state: () => invoke("workbench:state"),
    chooseWorkspace: () => invoke("workbench:chooseWorkspace"),
    start: (input) => invoke("workbench:start", input),
    snapshot: (id) => invoke("workbench:snapshot", id),
    write: (id, data) => invoke("workbench:write", id, data),
    resize: (id, cols, rows) => invoke("workbench:resize", id, cols, rows),
    stop: (id) => invoke("workbench:stop", id),
    remove: (id) => invoke("workbench:remove", id),
    close: (id) => invoke("workbench:close", id),
    setTerminalBackend: (id) => invoke("workbench:setTerminalBackend", id),
    reattach: (id) => invoke("workbench:reattach", id),
    hideWindow: () => invoke("workbench:hideWindow"),
    openPreview: () => invoke("workbench:openPreview"),
    onEvent: (callback) => subscribe("workbench:event", callback),
    // The payload is a KeyAction name (src/shared/keymap.ts HOST_ACTIONS).
    onShortcut: (callback) =>
      subscribe("workbench:shortcut", (action) => {
        if (typeof action === "string") callback(action as KeyAction);
      }),
  };
}
