import { createRoot } from "react-dom/client";
import { App } from "../../../src/renderer/App";
import { createDemoBridge } from "../../../src/shared/demo";
import type { WorkbenchBridge } from "../../../src/shared/workbench";
import type { WorkbenchAction } from "../../../src/shared/workbench-shortcuts";
import "../../../src/renderer/styles.css";
const bridge = createDemoBridge();
if (new URLSearchParams(location.search).has("enabled")) {
  const listeners = new Set<(action: WorkbenchAction) => void>();
  const state = {
    workspace: "/tmp/synthetic-reels-source",
    sessions: [],
    previewURL: "http://127.0.0.1:4183",
    providers: [{ id: "codex" as const, label: "Codex" }],
    defaultProvider: "codex" as const,
  };
  const workbench: WorkbenchBridge = {
    state: async () => state,
    chooseWorkspace: async () => state,
    start: async () => {
      throw new Error("This test must not start a process");
    },
    snapshot: async () => {
      throw new Error("No terminal sessions");
    },
    write: async () => {
      throw new Error("No automatic PTY submission");
    },
    resize: async () => {},
    stop: async () => {},
    remove: async () => {},
    close: async () => {},
    hideWindow: async () => {},
    openPreview: async () => {},
    onEvent: () => () => {},
    onShortcut: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  Object.assign(bridge, { workbench });
  document.addEventListener("keydown", (event) => {
    if (event.metaKey && event.shiftKey && event.code === "KeyC") {
      event.preventDefault();
      listeners.forEach((callback) => callback({ type: "inspect" }));
    }
  });
}
createRoot(document.getElementById("root")!).render(<App bridge={bridge} />);
