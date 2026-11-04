import { useState } from "react";
import { errorMessage } from "../lib/errors";

export type BusySetters = {
  setBusy: (busy: boolean) => void;
  setError: (error: string) => void;
  setNotice?: (notice: string) => void;
};

/**
 * The shared busy-wrapper contract (workdesk #66 useBusy, adapted):
 * - a run while another is in flight returns immediately (lock, not React state,
 *   so two calls in the same task cannot both start);
 * - start: busy on, error cleared, notice cleared when a notice setter exists;
 * - failure: error = errorMessage(e);
 * - always: unlock and busy off.
 * Only adopt it where a wrapper already matches exactly — see docs/workdesk-adoption.md.
 */
export function createBusyRunner({ setBusy, setError, setNotice }: BusySetters) {
  let locked = false;
  async function run(op: () => Promise<unknown>): Promise<void> {
    if (locked) return;
    locked = true;
    setBusy(true);
    setError("");
    setNotice?.("");
    try {
      await op();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      locked = false;
      setBusy(false);
    }
  }
  return { run };
}

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // useState setters are stable, so one runner (and one lock) lives for the mount.
  const [runner] = useState(() =>
    createBusyRunner({ setBusy, setError, setNotice }),
  );
  return { busy, error, setError, notice, setNotice, run: runner.run };
}
