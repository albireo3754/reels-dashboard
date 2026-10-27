// Invoked by test-native-install.mjs through node --import tsx. This exercises
// the production bridge, not a QA-only process shutdown implementation.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeClient, type NativeOptions } from "../../src/desktop/native";

const options = JSON.parse(process.argv[2]!) as NativeOptions;
const client = new NativeClient(options);
const status = (await client.request("status", {})) as {
  protocolVersion: number;
};
assert.equal(status.protocolVersion, 1);
const metadata = path.join(options.support, "helper-instance.json");
const identity = JSON.parse(readFileSync(metadata, "utf8")) as {
  pid: number;
  socketPath: string;
};
assert.equal(identity.socketPath, options.socket);
assert.ok(identity.pid > 1);

// An ordinary command error must not cause dispose to abandon ownership.
// This queries no library asset: this fresh helper has not indexed any date.
await assert.rejects(
  client.request("groups.show", { id: "nonexistent-qa-group" }),
);
await client.dispose();
let stopped = false;
for (let attempt = 0; attempt < 100; attempt++) {
  let alive = true;
  try {
    process.kill(identity.pid, 0);
  } catch {
    alive = false;
  }
  if (!alive && !existsSync(metadata) && !existsSync(options.socket)) {
    stopped = true;
    break;
  }
  await delay(50);
}
assert.ok(
  stopped,
  "Production NativeClient.dispose must stop its Korean/spaced-path helper after a command error",
);
console.log("PASS: production NativeClient start/error/dispose under a Korean/spaced install with C locale");
