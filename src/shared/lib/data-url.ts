/** Split a base64 `data:` URL. Reads the prefix only; decoding stays with the caller. */
export function parseDataUrl(
  value: unknown,
): { mimeType: string; data: string } | null {
  if (typeof value !== "string") return null;
  const match = /^data:([^,]*);base64,/.exec(value);
  return match
    ? { mimeType: match[1] || "text/plain", data: value.slice(match[0].length) }
    : null;
}
