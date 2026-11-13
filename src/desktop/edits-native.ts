import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EditsNativeOperation, EditsNativePort } from "../shared/edits";

/** Owned only by Electron main. CLI and MCP never import or spawn this client. */
export class EditsNativeClient implements EditsNativePort {
  private children = new Set<ChildProcess>();
  private closed = false;
  constructor(
    private binary: string,
    private timeoutMs = 20_000,
  ) {}
  invoke(
    operation: EditsNativeOperation,
    args: Record<string, unknown>,
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("EDITS_HELPER_CLOSED"));
    const id = randomUUID();
    const request = JSON.stringify({ protocol: 1, id, operation, args });
    if (Buffer.byteLength(request) > 1024 * 1024)
      return Promise.reject(new Error("EDITS_REQUEST_LIMIT"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      const stdout: Buffer[] = [];
      let stderr = "",
        bytes = 0,
        done = false;
      const finish = (error?: Error, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => {
          child.kill("SIGKILL");
          finish(
            new Error(
              "EDITS_HELPER_TIMEOUT: outcome unknown; read state before retrying a write",
            ),
          );
        },
        operation === "screenshot"
          ? Math.max(30_000, this.timeoutMs)
          : this.timeoutMs,
      );
      child.on("error", (error) =>
        finish(new Error(`EDITS_HELPER_UNAVAILABLE: ${error.message}`)),
      );
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          child.kill("SIGKILL");
          finish(new Error("EDITS_HELPER_OUTPUT_LIMIT: outcome unknown"));
        } else stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        if (done) return;
        try {
          const response = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          if (
            response.protocol !== 1 ||
            response.id !== id ||
            typeof response.ok !== "boolean"
          )
            throw new Error("invalid envelope");
          if (!response.ok) {
            const error = new Error(
              `${response.error?.code ?? "EDITS_HELPER_FAILED"}: ${response.error?.message ?? "native operation failed"}`,
            );
            Object.assign(error, {
              code: response.error?.code,
              details: response.error?.details,
            });
            finish(error);
          } else if (code !== 0)
            finish(new Error(`EDITS_HELPER_EXIT: ${code}; outcome unknown`));
          else finish(undefined, response.result);
        } catch (error) {
          finish(
            new Error(
              `EDITS_HELPER_PROTOCOL: ${error instanceof Error ? error.message : "invalid JSON"}; outcome unknown${stderr ? " (native diagnostics available)" : ""}`,
            ),
          );
        }
      });
      child.stdin.on("error", () => {}); // close/error above owns the final outcome
      child.stdin.end(request);
    });
  }
  dispose() {
    this.closed = true;
    for (const child of this.children) child.kill("SIGKILL");
  }
}
