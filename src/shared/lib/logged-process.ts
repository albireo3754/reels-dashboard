import {
  spawn,
  execFile,
  type ChildProcess,
  type SpawnOptions,
  type ExecFileOptions,
} from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ExecutionLogs, redactLog } from "./execution-logs";
import type { ExecutionStart } from "../execution-log";

type Context = Omit<ExecutionStart, "executable">;
function observe(
  logs: ExecutionLogs,
  id: string,
  child: ChildProcess,
  duration?: number,
) {
  logs.update(id, { pid: child.pid });
  let output = "",
    pending = "",
    progress: number | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    logs.update(id, {
      output,
      ...(progress === undefined ? {} : { progress }),
    });
  };
  const consume = (text: string, stdout: boolean) => {
    if (!stdout) output = (output + text).slice(-32000);
    if (stdout) {
      pending = (pending + text).slice(-32000);
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "progress" && Number.isFinite(event.percent))
            progress = Math.max(0, Math.min(99, event.percent));
          // Do not persist image/base64 payloads or document bodies from engine results.
          if (event.type === "result") {
            const paths = [event.outputPath, event.manifestPath].filter(
              (v) => typeof v === "string",
            );
            output = (
              output +
              "\n엔진 결과 수신" +
              (paths.length ? ": " + paths.join(", ") : "") +
              "\n"
            ).slice(-32000);
          }
        } catch {
          /* ffmpeg emits key=value, the editor emits JSON. */
        }
        if (duration && duration > 0 && line.startsWith("out_time_us=")) {
          const value = Number(line.slice(12));
          if (Number.isFinite(value))
            progress = Math.max(
              0,
              Math.min(99, (value / 1e6 / duration) * 100),
            );
        }
      }
    }
    if (!timer) timer = setTimeout(flush, 1000);
  };
  for (const [stream, stdout] of [
    [child.stdout, true],
    [child.stderr, false],
  ] as const) {
    const decoder = new StringDecoder("utf8");
    stream?.on("data", (chunk) =>
      consume(
        decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        stdout,
      ),
    );
    stream?.on("end", () => {
      const tail = decoder.end();
      if (tail) consume(tail, stdout);
    });
  }
  child.once("error", (error) => {
    output += "\n" + redactLog(error.message);
    // A failed spawn has no process to wait for. Otherwise close is authoritative.
    if (!child.pid) {
      ended = true;
      flush();
      logs.finish(id, "failed", "프로세스를 시작하지 못했어요.");
    }
  });
  child.once("close", (code, signal) => {
    if (ended) return;
    ended = true;
    flush();
    logs.update(id, {
      ...(code === null ? {} : { exitCode: code }),
      ...(signal ? { signal } : {}),
      ...(code === 0 ? { progress: 100 } : {}),
    });
    logs.finish(
      id,
      code === 0 ? "completed" : "failed",
      signal ? `종료 신호: ${signal}` : `종료 코드: ${code ?? "없음"}`,
    );
  });
  return child;
}

export function loggedSpawn(
  logs: ExecutionLogs,
  context: Context,
  executable: string,
  args: string[],
  options: SpawnOptions,
  duration?: number,
) {
  const id = logs.start({ ...context, executable: path.basename(executable) });
  try {
    return observe(logs, id, spawn(executable, args, options), duration);
  } catch (error) {
    logs.finish(id, "failed", "프로세스 실행 요청 실패");
    throw error;
  }
}

export function loggedExecFile(
  logs: ExecutionLogs,
  context: Context,
  executable: string,
  args: string[],
  options: ExecFileOptions,
) {
  const id = logs.start({ ...context, executable: path.basename(executable) });
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    try {
      let result: { stdout: string; stderr: string } | undefined;
      let failure: Error | null = null;
      const child = execFile(
        executable,
        args,
        options,
        (error, stdout, stderr) => {
          failure = error;
          result = { stdout: String(stdout), stderr: String(stderr) };
        },
      );
      observe(logs, id, child);
      child.stdin?.end();
      child.once("close", () =>
        failure
          ? reject(failure)
          : resolve(result ?? { stdout: "", stderr: "" }),
      );
    } catch (error) {
      logs.finish(id, "failed", "프로세스 실행 요청 실패");
      reject(error);
    }
  });
}
