import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readBody,
  readJsonBody,
  RequestTooLargeError,
} from "../../src/app/lib/http";

const request = (...chunks: Buffer[]) =>
  Object.assign(
    (async function* () {
      yield* chunks;
    })(),
    { headers: {} },
  );

test("request bodies keep multi-byte characters split across chunks", async () => {
  const bytes = Buffer.from(JSON.stringify({ text: "벤치에서 차를 마셨어요" }));
  const split = bytes.indexOf(Buffer.from("치")) + 1; // inside a 3-byte character
  assert.deepEqual(
    await readJsonBody(
      request(bytes.subarray(0, split), bytes.subarray(split)),
      1024,
    ),
    { text: "벤치에서 차를 마셨어요" },
  );
});

test("request bodies over the byte limit are rejected with the given message", async () => {
  await assert.rejects(
    readBody(
      request(Buffer.alloc(6), Buffer.alloc(6)),
      10,
      "본문이 너무 커요.",
    ),
    (error: unknown) =>
      error instanceof RequestTooLargeError &&
      error.message === "본문이 너무 커요.",
  );
});
