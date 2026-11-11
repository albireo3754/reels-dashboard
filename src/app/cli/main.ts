import { writeSync } from "node:fs";
import { errorMessage } from "../../shared/lib/errors";
import { exitCodes } from "./outcome";
import { run } from "./run";

const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * A stream writing to a file drops the rest of a partial write without an error,
 * which would leave cut-off JSON behind exit 0. This checks every byte instead.
 */
function writeAll(fd: number, text: string) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length)
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (error) {
      // stderr's stream can leave a pipe shared with stdout non-blocking.
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
}

// A reader closing the pipe early is not a failure worth a stack trace.
const ignoreClosedPipe = (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
};
process.stderr.on("error", ignoreClosedPipe);
const flushed = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => stream.write("", () => resolve()));
let stdoutFailed = false;
const code = await run(process.argv.slice(2), {
  stdin: () => process.stdin,
  stdout(text) {
    try {
      // The fd, not process.stdout: creating that stream makes a pipe non-blocking.
      writeAll(1, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
      stdoutFailed = true;
      process.stderr.write(
        `reels: could not write stdout: ${errorMessage(error)}\n`,
      );
    }
  },
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  // Read on demand: the working folder may be gone, and most commands never need it.
  cwd: () => process.cwd(),
});
// Exit outright: an interrupted run can still hold a stdin read or a file copy open.
await flushed(process.stderr);
process.exit(stdoutFailed ? code || exitCodes.localIo : code);
