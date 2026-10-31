import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  WorkbenchBridge,
  WorkbenchEvent,
} from "../../../shared/workbench";
import "@xterm/xterm/css/xterm.css";

export function TerminalPane({
  api,
  id,
  active,
}: {
  api: WorkbenchBridge;
  id: string;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, monospace",
      scrollback: 4000,
      theme: { background: "#151b27", foreground: "#e3e9f3" },
    });
    const fit = new FitAddon();
    terminalRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host.current!);
    let disposed = false,
      ready = false,
      sequence = 0;
    const pending: Extract<WorkbenchEvent, { type: "data" }>[] = [];
    const report = (e: unknown) => {
      if (!disposed) term.writeln(`\r\n[${String(e)}]`);
    };
    const apply = (event: Extract<WorkbenchEvent, { type: "data" }>) => {
      if (event.sequence <= sequence) return;
      sequence = event.sequence;
      term.write(event.data);
    };
    // Subscribe before requesting backlog, then skip already included events.
    const off = api.onEvent((event) => {
      if (event.type !== "data" || event.id !== id) return;
      if (ready) apply(event);
      else pending.push(event);
    });
    void api
      .snapshot(id)
      .then((snapshot) => {
        if (disposed) return;
        term.write(snapshot.output);
        sequence = snapshot.sequence;
        ready = true;
        pending.forEach(apply);
        pending.length = 0;
        if (
          activeRef.current &&
          host.current?.clientWidth &&
          host.current?.clientHeight
        ) {
          fit.fit();
          void api.resize(id, term.cols, term.rows).catch(report);
        }
      })
      .catch(report);
    const input = term.onData((data) => {
      if (activeRef.current) void api.write(id, data).catch(report);
    });
    const resized = term.onResize(({ cols, rows }) => {
      if (activeRef.current) void api.resize(id, cols, rows).catch(report);
    });
    const observer = new ResizeObserver(() => {
      if (
        activeRef.current &&
        host.current?.clientWidth &&
        host.current?.clientHeight
      )
        fit.fit();
    });
    observer.observe(host.current!);
    return () => {
      disposed = true;
      off();
      input.dispose();
      resized.dispose();
      observer.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [api, id]);
  useEffect(() => {
    if (active) {
      const frame = requestAnimationFrame(() => {
        if (host.current?.clientWidth && host.current?.clientHeight)
          fitRef.current?.fit();
        terminalRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    terminalRef.current?.blur();
  }, [active]);
  return (
    <div
      ref={host}
      className="dev-terminal"
      data-session-id={id}
      aria-label="개발 터미널"
    />
  );
}
