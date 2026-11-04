/** Today's (or `at`'s) calendar date in the machine's time zone, as YYYY-MM-DD. */
export const localDate = (at: Date = new Date()) =>
  at.toLocaleDateString("en-CA");

/** Full Korean date and time, or `fallback` when the value is missing or invalid. */
export function koreanDateTime(
  value: string | null | undefined,
  fallback = "",
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString("ko-KR", options)
    : fallback;
}
