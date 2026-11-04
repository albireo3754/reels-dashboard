import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_KEYMAP,
  isHostAction,
  isModeAction,
  matchAction,
  type KeyAction,
  type Keymap,
} from "../../keymap";

/** The minimum of a keydown event the dispatcher reads; `null` for a host IPC action. */
export interface ShortcutEvent {
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
export type ShortcutHandler = (action: KeyAction) => void;
/** Whether a registered shortcut should take this key; false lets it fall through untouched. */
export type ShortcutLive = (
  action: KeyAction,
  event: ShortcutEvent | null,
) => boolean;
interface Registration {
  handler: ShortcutHandler;
  live?: ShortcutLive;
}
/** Latest registration wins per action; each entry is a ref the hook keeps current. */
export type ShortcutRegistry = Map<KeyAction, { current: Registration }[]>;

/** The source of host-scope actions (the dev desktop `workbench` bridge or its web fixture). */
export interface ShortcutHost {
  onShortcut(callback: (action: KeyAction) => void): () => void;
}

/**
 * Mouse side buttons (MouseEvent.button 3/4). Fixed, not part of the keymap, and
 * dispatched like a renderer key, so the same `live` predicate gates them.
 */
const MOUSE_ACTIONS: Readonly<Record<number, KeyAction>> = Object.freeze({
  3: "goBack",
  4: "goForward",
});

const latest = (registry: ShortcutRegistry, action: KeyAction) =>
  registry.get(action)?.at(-1)?.current;

/**
 * Runs the handler for a renderer keydown. Returns whether the key was taken.
 * HOST_ACTIONS are ignored here: they arrive only through the host IPC, so a
 * renderer key never adds them to non-dev desktop or web, and never runs twice.
 * A live binding's auto-repeat is consumed but not re-run (workdesk
 * useShortcuts), so holding ⌘[ never leaks a browser history step.
 */
function dispatchShortcut(
  registry: ShortcutRegistry,
  action: KeyAction,
  event: ShortcutEvent,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (isHostAction(action)) return false;
  const entry = latest(registry, action);
  if (!entry || (entry.live && !entry.live(action, event))) return false;
  event.preventDefault();
  if (isModeAction(action)) event.stopPropagation();
  if (!event.repeat) entry.handler(action);
  return true;
}

interface ShortcutsContextValue {
  keymap: Keymap;
  registry: ShortcutRegistry;
}
const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);
/**
 * Whether ⌘ is held. Kept apart from ShortcutsContext so a ⌘ press re-renders
 * only the ShortcutHint consumers, never the owners of the registry (workdesk
 * #65: a provider-wide re-render on every ⌘ press reset chat scroll).
 */
const RevealContext = createContext(false);

/**
 * One keymap and one dispatcher for the renderer. Upstream workdesk dispatches
 * from a single switch; here the handler state lives in different owners (App
 * owns inspection, DevWorkspace the drawer and sessions, WorkspaceToolbar the
 * search panel), so owners register handlers into this provider's registry
 * instead. It stays one provider, one keymap and one set of listeners:
 *
 * - host actions: `host.onShortcut` (Electron `before-input-event`, dev mode only);
 * - renderer actions (quickOpen): one window keydown listener in the bubble
 *   phase, so terminal and form handlers keep running first;
 * - mode actions (exitInspect): one window keydown listener in the capture
 *   phase, so a live mode pre-empts the focused element;
 * - mouse side buttons (goBack/goForward): one window mouseup capture listener.
 *   Like ⌘[ / ⌘], they never fire while the preview iframe or other
 *   cross-origin content has focus or sits under the pointer: those events stay
 *   in that frame, and there is no host path for them;
 * - the ⌘-held state for ShortcutHint: window keydown/keyup capture listeners
 *   that only observe (never preventDefault), cleared on blur and when the page
 *   is hidden. While the preview iframe has focus the renderer gets no Meta
 *   events, so hints do not appear there.
 */
export function ShortcutsProvider({
  host,
  children,
}: {
  host?: ShortcutHost;
  children: ReactNode;
}) {
  const [value] = useState<ShortcutsContextValue>(() => ({
    keymap: DEFAULT_KEYMAP,
    registry: new Map(),
  }));
  useEffect(
    () =>
      host?.onShortcut((action) => {
        if (!isHostAction(action)) return;
        const entry = latest(value.registry, action);
        if (entry && (!entry.live || entry.live(action, null)))
          entry.handler(action);
      }),
    [host, value],
  );
  useEffect(() => {
    const listener = (mode: boolean) => (event: KeyboardEvent) => {
      const action = matchAction(value.keymap, event, "renderer");
      if (action && isModeAction(action) === mode)
        dispatchShortcut(value.registry, action, event);
    };
    const bubble = listener(false);
    const capture = listener(true);
    const mouse = (event: MouseEvent) => {
      const action = MOUSE_ACTIONS[event.button];
      if (action) dispatchShortcut(value.registry, action, event);
    };
    window.addEventListener("keydown", bubble);
    window.addEventListener("keydown", capture, true);
    window.addEventListener("mouseup", mouse, true);
    return () => {
      window.removeEventListener("keydown", bubble);
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("mouseup", mouse, true);
    };
  }, [value]);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => setRevealed(event.metaKey);
    const up = (event: KeyboardEvent) =>
      setRevealed(event.key !== "Meta" && event.metaKey);
    const clear = () => setRevealed(false);
    const visibility = () => {
      if (document.visibilityState === "hidden") clear();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return (
    <ShortcutsContext.Provider value={value}>
      <RevealContext.Provider value={revealed}>{children}</RevealContext.Provider>
    </ShortcutsContext.Provider>
  );
}

const useShortcutsContext = () => {
  const context = useContext(ShortcutsContext);
  if (!context) throw new Error("ShortcutsProvider is not mounted");
  return context;
};

/** The active keymap, for hints. A stable reference. */
export const useKeymap = (): Keymap => useShortcutsContext().keymap;

/** Whether ⌘ is held, for ShortcutHint. Re-renders only its consumers. */
export const useShortcutsRevealed = (): boolean => useContext(RevealContext);

/**
 * Registers `handler` for one or more actions while mounted. The handler and the
 * `live` predicate are read through refs, so callers may pass fresh closures.
 */
export function useShortcut(
  action: KeyAction | readonly KeyAction[],
  handler: ShortcutHandler,
  live?: ShortcutLive,
) {
  const { registry } = useShortcutsContext();
  const ref = useRef<Registration>({ handler, live });
  useLayoutEffect(() => {
    ref.current = { handler, live };
  });
  const key = typeof action === "string" ? action : action.join(" ");
  useEffect(() => {
    const actions = key.split(" ") as KeyAction[];
    for (const a of actions) registry.set(a, [...(registry.get(a) ?? []), ref]);
    return () => {
      for (const a of actions) {
        const rest = (registry.get(a) ?? []).filter((entry) => entry !== ref);
        if (rest.length) registry.set(a, rest);
        else registry.delete(a);
      }
    };
  }, [registry, key]);
}
