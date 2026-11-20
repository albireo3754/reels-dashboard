// Local E2E for Sites instructions: the real runner and site API client against a
// LOCAL site (loopback http only) with the fake launcher. No Paseo agent starts,
// no Keychain is read, and data lives in a fresh temp folder.
//
//   REELS_BRIDGE_URL=http://127.0.0.1:<port> REELS_BRIDGE_KEY_FILE=<0600 key file> \
//     node --import tsx scripts/mobile-briefing/instructions-e2e.ts [seconds=90]
//
// Put "[fake:needs_user]", "[fake:failed]", "[fake:missing]" … in an instruction's
// text to pick the fake agent's outcome (default: done).
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeLauncher } from "./fake-launcher";
import { InstructionRunner, createInstructionApi } from "./instructions";

const url = process.env.REELS_BRIDGE_URL ?? "";
const keyFile = process.env.REELS_BRIDGE_KEY_FILE ?? "";
const seconds = Number(process.argv[2] ?? 90);
const base = new URL(url);
if (
  base.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
)
  throw new Error("Local E2E only: REELS_BRIDGE_URL must be http on loopback");
const st = await lstat(keyFile);
if (!st.isFile() || st.mode & 0o077)
  throw new Error("Key file must be a private regular file");
const key = (await readFile(keyFile, "utf8")).trim();

const root = await mkdtemp(path.join(os.tmpdir(), "instructions-e2e-"));
const home = await mkdtemp(path.join(os.tmpdir(), "instructions-e2e-home-"));
await writeFile(
  path.join(root, "instructions.json"),
  JSON.stringify({
    enabled: true,
    cwd: home,
    preMergeCwd: home,
    pollSeconds: 10,
  }),
);
const api = createInstructionApi((route, init) =>
  fetch(new URL(route, base), {
    ...init,
    headers: {
      ...init.headers,
      "X-Reels-Bridge-Key": key,
      "OAI-Sites-Authorization": "Bearer " + key,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  }),
);
const runner = new InstructionRunner({
  root,
  api,
  launcher: new FakeLauncher({ autoCompleteMs: 2000 }),
  home,
  lockState: async () => ({ locked: false, known: true }),
  graceMs: 5000,
  log: (m) => console.log(new Date().toISOString(), m),
});
const heartbeat = () =>
  fetch(new URL("/api/bridge/heartbeat", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reels-Bridge-Key": key,
      "OAI-Sites-Authorization": "Bearer " + key,
    },
    body: JSON.stringify(runner.heartbeat()),
  }).then((r) =>
    console.log(
      new Date().toISOString(),
      "heartbeat " + r.status + " " + JSON.stringify(runner.heartbeat()),
    ),
  );
try {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await runner.tick();
    await heartbeat().catch(() => console.log("heartbeat FAILED"));
    await new Promise((r) => setTimeout(r, 2000));
  }
} finally {
  await runner.release();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
