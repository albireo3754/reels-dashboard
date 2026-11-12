import { z } from "zod";

/** Absolute POSIX path without NUL bytes; `message` overrides the NUL error text. */
export const absolutePathSchema = (message?: string) =>
  z
    .string()
    .min(1)
    .max(4096)
    .startsWith("/")
    .refine((v) => !v.includes("\0"), message);
