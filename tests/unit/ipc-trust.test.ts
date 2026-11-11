import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedIpcSender, type IpcSenderCheck } from "../../src/desktop/ipc-trust";
import { createWorkbenchBridge } from "../../src/desktop/workbench-bridge";

const dashboard = { sender: { id: "dashboard" }, frame: { id: "dashboard-main" } };
const base = (over: Partial<IpcSenderCheck>): IpcSenderCheck => ({
  sender: dashboard.sender,
  frame: dashboard.frame,
  dashboard,
  ...over,
});

test("only the live dashboard window's main frame is trusted", () => {
  assert.equal(trustedIpcSender(base({})), true);
});

test("dashboard subframes are rejected: embedded blog editors, their manuscript frames, the preview", () => {
  for (const id of ["blog-editor-iframe", "manuscript-iframe", "preview-iframe"])
    assert.equal(trustedIpcSender(base({ frame: { id } })), false, id);
});

test("other windows, destroyed frames and a destroyed dashboard are rejected", () => {
  assert.equal(trustedIpcSender(base({ sender: { id: "capture-window" } })), false);
  assert.equal(trustedIpcSender(base({ frame: null })), false);
  assert.equal(trustedIpcSender(base({ sender: undefined })), false);
  assert.equal(trustedIpcSender(base({ dashboard: undefined })), false);
  // The main frame of another window does not match the dashboard's contents.
  assert.equal(
    trustedIpcSender(base({ sender: { id: "editor" }, frame: dashboard.frame })),
    false,
  );
});

test("shared workbench bridge invokes reels:workbench:* and filters shortcut payloads", async () => {
  const calls: unknown[][] = [];
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
  const bridge = createWorkbenchBridge({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      return "ok";
    },
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(listener);
    },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
  });
  assert.equal(await bridge.state(), "ok");
  await bridge.write("s1", "ls\r");
  await bridge.resize("s1", 80, 24);
  await bridge.setTerminalBackend("direct");
  await bridge.reattach("s1");
  await bridge.hideWindow();
  assert.deepEqual(calls, [
    ["reels:workbench:state"],
    ["reels:workbench:write", "s1", "ls\r"],
    ["reels:workbench:resize", "s1", 80, 24],
    ["reels:workbench:setTerminalBackend", "direct"],
    ["reels:workbench:reattach", "s1"],
    ["reels:workbench:hideWindow"],
  ]);
  const actions: string[] = [];
  const events: unknown[] = [];
  const offShortcut = bridge.onShortcut((action) => actions.push(action));
  const offEvent = bridge.onEvent((event) => events.push(event));
  for (const listener of listeners.get("workbench:shortcut")!) {
    listener({}, "toggleDrawer");
    listener({}, 42);
  }
  for (const listener of listeners.get("workbench:event")!) listener({}, { type: "changed" });
  assert.deepEqual(actions, ["toggleDrawer"]);
  assert.deepEqual(events, [{ type: "changed" }]);
  offShortcut();
  offEvent();
  assert.equal(listeners.get("workbench:shortcut")!.size, 0);
  assert.equal(listeners.get("workbench:event")!.size, 0);
});
