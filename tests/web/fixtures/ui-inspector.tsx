import { createRoot } from "react-dom/client";
import { App } from "../../../src/renderer/App";
import { createDemoBridge } from "../../../src/shared/demo";
import type { WorkbenchBridge } from "../../../src/shared/workbench";
import type { KeyAction } from "../../../src/shared/keymap";
import { ShortcutsProvider } from "../../../src/shared/ui/shortcuts";
import { UiInspector } from "../../../src/features/ui-inspector";
import "../../../src/renderer/styles.css";
const bridge = createDemoBridge();
if (new URLSearchParams(location.search).has("enabled")) {
  const listeners = new Set<(action: KeyAction) => void>();
  const state = {
    workspace: "/tmp/synthetic-reels-source",
    sessions: [],
    previewURL: "http://127.0.0.1:4183",
    providers: [
      { id: "codex" as const, label: "Codex" },
      { id: "claude" as const, label: "Claude Code" },
    ],
    defaultProvider: "codex" as const,
    terminalBackend: {
      selected: "direct" as const,
      effective: "direct" as const,
      herdrInstalled: false,
      session: "default",
      forcedByEnv: true,
      checking: false,
    },
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
    setTerminalBackend: async () => state,
    reattach: async () => {
      throw new Error("No terminal sessions");
    },
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
      listeners.forEach((callback) => callback("inspectUi"));
    }
  });
}
// `standalone` mounts only the inspector and keeps it mounted after onClose,
// so a test can count onClose/onFeedback calls and see whether an Escape
// still reaches document listeners (App's modal Esc, the blog editor's Esc).
const counts = { close: 0, feedback: [] as string[], documentEscape: 0, cancel: 0 };
Object.assign(window, { inspectorCounts: counts });
const params = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(
  <ShortcutsProvider host={bridge.workbench}>
    {params.has("standalone") ? (
      <>
        <button type="button">합성 대상</button>
        <UiInspector
          onClose={() => counts.close++}
          onFeedback={(text) => counts.feedback.push(text)}
        />
      </>
    ) : (
      <App bridge={bridge} />
    )}
  </ShortcutsProvider>,
);
if (params.has("standalone")) {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") counts.documentEscape++;
  });
  document.addEventListener("cancel", () => counts.cancel++, true);
}
