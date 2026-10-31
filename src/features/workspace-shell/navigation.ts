import { useCallback, useState } from "react";

export interface Navigation<T extends string> {
  entries: T[];
  index: number;
}
export function visit<T extends string>(
  state: Navigation<T>,
  target: T,
): Navigation<T> {
  if (state.entries[state.index] === target) return state;
  const entries = [...state.entries.slice(0, state.index + 1), target].slice(
    -30,
  );
  return { entries, index: entries.length - 1 };
}
export function useWorkspaceNavigation<T extends string>(initial: T) {
  const [state, setState] = useState<Navigation<T>>({
    entries: [initial],
    index: 0,
  });
  const navigate = useCallback(
    (target: T) => setState((s) => visit(s, target)),
    [],
  );
  const jump = useCallback(
    (index: number) =>
      setState((s) => ({
        ...s,
        index: Math.max(0, Math.min(index, s.entries.length - 1)),
      })),
    [],
  );
  return { ...state, current: state.entries[state.index], navigate, jump };
}
