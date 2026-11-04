/** User-facing text for a thrown value. Non-Error throws keep their string form unless a fallback is given. */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
