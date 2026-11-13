import { EmptyState } from "../shared/ui/primitives";
import type { ReactNode } from "react";

export const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
export const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const iconPaths: Record<string, string> = {
  insights: "M4 3v18h17 M8 17v-5 M13 17V7 M18 17V4",
  calendar: "M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 18h2",
  dashboard: "M3 3h7v7H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 14h7v7H3z",
  library: "M4 5h16v15H4z M8 2h8 M4 15l5-5 4 4 3-2 4 4",
  transfers: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
  editor: "M4 4h16v16H4z M10 8l6 4-6 4z M4 8H2 M4 16H2 M20 8h2 M20 16h2",
  cards: "M6 3h15v16H6z M3 7v15h14 M9 8h9 M9 12h9 M9 16h5",
  settings: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  plus: "M12 5v14 M5 12h14",
  check: "M5 12l4 4L19 6",
  close: "M6 6l12 12 M18 6L6 18",
  // Pencil: edit a record.
  edit: "M4 20h4L19 9l-4-4L4 16z M14 6l4 4",
  // Arrow leaving a box: opens outside the app.
  external: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  // Page with a folded corner and text lines: blog drafts.
  blog: "M5 3h10l4 4v14H5z M15 3v4h4 M8 12h8 M8 16h5",
  // Three connected steps: a running workflow.
  workflow:
    "M3 5h6v5H3z M15 14h6v5h-6z M9 7.5h3a3 3 0 0 1 3 3V14 M9 16.5h6 M3 14h6v5H3z",
  // Terminal-style log lines.
  logs: "M4 4h16v16H4z M7 9l3 3-3 3 M12 15h5",
};

/** 16px line icon (sidebar, rows, buttons). */
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name] || iconPaths.dashboard} />
    </svg>
  );
}
export function JSONDetails({
  data,
  label = "자세한 결과",
}: {
  data: unknown;
  label?: string;
}) {
  return (
    <details className="json-details">
      <summary>{label}</summary>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}
/** One-line empty state. `children` is the single description line. */
export function Empty({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <EmptyState
      className="empty"
      icon={<Icon name="library" size={20} />}
      title={title}
      description={children}
      actions={actions}
    />
  );
}
