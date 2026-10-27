import { spawn, execFile } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import {
  commandMethods,
  type Arguments,
  type CommandMethod,
} from "../shared/contracts";
const allowed: Record<CommandMethod, readonly string[]> = {
  status: [],
  authorize: [],
  sync: ["date"],
  "groups.list": ["date", "level"],
  "groups.show": ["id", "index-run"],
  "groups.inspect": ["id", "index-run", "page", "page-size", "samples"],
  "decisions.validate": ["file"],
  "export.plan": ["decision", "to", "layout"],
  "export.apply": ["plan", "digest"],
  "move.plan": ["decision", "to", "layout"],
  "move.apply": ["plan", "digest"],
};
export function validateRequest(
  method: unknown,
  args: unknown,
): asserts method is CommandMethod {
  if (
    typeof method !== "string" ||
    !commandMethods.includes(method as CommandMethod)
  )
    throw new Error("Unsupported command");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Invalid arguments");
  for (const [key, value] of Object.entries(args))
    if (
      !allowed[method as CommandMethod].includes(key) ||
      typeof value !== "string" ||
      value.length > 8192 ||
      value.includes("\0")
    )
      throw new Error("Invalid command argument");
}
export interface NativeOptions {
  cli: string;
  app: string;
  socket: string;
  support: string;
  exportRoot?: string;
}
export class NativeClient {
  private boot?: Promise<void>;
  constructor(readonly options: NativeOptions) {}
  private async ensureReady() {
    if (this.boot) return this.boot;
    this.boot = (async () => {
      await access(this.options.cli);
      await access(this.options.app);
      await new Promise<void>((resolve, reject) => {
        const env = {
          ...process.env,
          PHOTOSINDEX_APP_PATH: this.options.app,
          PHOTOSINDEX_SOCKET_PATH: this.options.socket,
          PHOTOSINDEX_SUPPORT_ROOT: this.options.support,
          ...(this.options.exportRoot
            ? { PHOTOSINDEX_EXPORT_ROOT: this.options.exportRoot }
            : {}),
        };
        const child = spawn(this.options.cli, ["status", "--format", "json"], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let error = "";
        let output = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Native helper launch timed out"));
        }, 20000);
        child.stdout.on("data", (d) => (output += d));
        child.stderr.on("data", (d) => (error += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0)
            return reject(
              new Error(error.trim() || "Native helper failed to launch"),
            );
          try {
            const status = JSON.parse(output);
            if (status.protocolVersion !== 1)
              throw new Error("Native protocol mismatch");
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    })();
    try {
      await this.boot;
    } catch (e) {
      this.boot = undefined;
      throw e;
    }
  }
  async dispose(): Promise<void> {
    try {
      if (this.boot) await this.boot;
      const metadata = path.join(this.options.support, "helper-instance.json");
      const original = await readFile(metadata, "utf8");
      const record = JSON.parse(original);
      const expected = (
        await realpath(
          path.join(this.options.app, "Contents/MacOS/PhotosIndex"),
        )
      ).normalize("NFC");
      if (
        record.schemaVersion !== 1 ||
        !Number.isInteger(record.pid) ||
        record.pid <= 1 ||
        record.socketPath !== this.options.socket ||
        (await realpath(record.executablePath)).normalize("NFC") !== expected
      )
        return;
      // macOS ps escapes non-ASCII paths in the C locale. Read the executable
      // separately so spaces and /var aliases cannot weaken the identity check.
      const processEnvironment = { ...process.env, LC_ALL: "en_US.UTF-8" };
      const executable = await execFileAsync(
        "/bin/ps",
        ["-ww", "-p", String(record.pid), "-o", "comm="],
        { env: processEnvironment },
      );
      if (
        (await realpath(executable.stdout.trim())).normalize("NFC") !== expected
      )
        return;
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-ww", "-p", String(record.pid), "-o", "command="],
        { env: processEnvironment },
      );
      if (
        !stdout.normalize("NFC").includes(this.options.socket.normalize("NFC"))
      )
        return;
      if ((await readFile(metadata, "utf8")) !== original) return;
      process.kill(record.pid, "SIGTERM");
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(record.pid, 0);
        } catch {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch {
      /* Already stopped or no verified ownership: never kill a guessed process. */
    }
  }
  async request(
    method: CommandMethod | "editor.materialize",
    args: Arguments,
  ): Promise<unknown> {
    await this.ensureReady();
    try {
      return await sendNative(this.options.socket, method, args);
    } catch (e) {
      this.boot = undefined;
      throw e;
    }
  }
}
export function sendNative(
  socketPath: string,
  method: CommandMethod | "editor.materialize",
  args: Arguments,
  timeout = 3_700_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let bytes = "";
    let settled = false;
    const socket = createConnection(socketPath);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeout, () =>
      finish(
        new Error(
          "Native operation timed out; inspect saved plan before retrying",
        ),
      ),
    );
    socket.on("error", (e) => finish(e));
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ protocolVersion: 1, id, method, arguments: args }) +
          "\n",
      ),
    );
    socket.on("data", (chunk) => {
      bytes += chunk.toString("utf8");
      if (Buffer.byteLength(bytes) > 8 * 1024 * 1024)
        return finish(new Error("Native response too large"));
      if (!bytes.includes("\n")) return;
      try {
        const response = JSON.parse(bytes.slice(0, bytes.indexOf("\n")));
        if (response.id !== id || response.protocolVersion !== 1)
          throw new Error("Native response identity mismatch");
        if (!response.ok)
          throw new Error(
            `${response.error?.code ?? "native-error"}: ${response.error?.message ?? "Command failed"}${response.error?.recovery ? " — " + response.error.recovery : ""}`,
          );
        if (typeof response.payload !== "string")
          throw new Error("Missing native payload");
        finish(
          undefined,
          JSON.parse(Buffer.from(response.payload, "base64").toString("utf8")),
        );
      } catch (e) {
        finish(e as Error);
      }
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("Native helper disconnected"));
    });
  });
}
