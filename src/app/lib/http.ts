import type { IncomingMessage } from "node:http";

export class RequestTooLargeError extends Error {}

/**
 * Read a request body as UTF-8, rejecting it once it exceeds `maxBytes`.
 * Chunks are concatenated as bytes before decoding, so multi-byte characters
 * split across chunk boundaries (e.g. Korean text) are preserved.
 */
export async function readBody(
  req: AsyncIterable<Buffer | string> & Pick<IncomingMessage, "headers">,
  maxBytes: number,
  message = "Request too large",
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.length;
    if (size > maxBytes) throw new RequestTooLargeError(message);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const readJsonBody = async (
  req: Parameters<typeof readBody>[0],
  maxBytes: number,
  message?: string,
): Promise<unknown> => JSON.parse(await readBody(req, maxBytes, message));
