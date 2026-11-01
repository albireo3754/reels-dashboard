/** Human-readable message of a thrown value; renderer- and Node-safe. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
