import { compareProductionPriority, isActiveState } from "@briefing/model";
import type { Content } from "./briefing-data";

export const stateOf = (c: Content) =>
  c.state ??
  (c.stage === "done" || c.stage === "published"
    ? "complete"
    : c.stage === "review"
      ? "review"
      : "in_progress");
export const active = (c: Content) => isActiveState(stateOf(c));

export function byPriority(a: Content, b: Content) {
  return (
    compareProductionPriority(a, b, stateOf(a), stateOf(b)) ||
    b.date.localeCompare(a.date) ||
    a.title.localeCompare(b.title, "ko")
  );
}

type BoardOptions = {
  tab: "contents" | "captures";
  filter: string;
  channel: string;
  kind: string;
  query: string;
  sort: string;
};
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();

export function selectContents(
  contents: readonly Content[],
  { tab, filter, channel, kind, query, sort }: BoardOptions,
) {
  const needle = normalize(query);
  const matches = contents.filter((c) => {
    if (tab === "captures" && !c.id.startsWith("capture:")) return false;
    const entry = c.publications?.find((p) => p.channel === channel);
    if (channel !== "all" && !entry) return false;
    if (kind !== "all" && (c.kind ?? "content") !== kind) return false;
    if (!normalize(`${c.title} ${c.next_action} ${c.date}`).includes(needle))
      return false;
    if (tab === "captures" || filter === "all") return true;
    switch (filter) {
      case "active":
        return active(c) && entry?.status !== "published";
      case "complete":
        return stateOf(c) === "complete";
      case "scheduled":
        return (
          stateOf(c) === "scheduled" ||
          !!c.publications?.some((p) => p.status === "scheduled")
        );
      default:
        return c.stage === filter;
    }
  });
  if (sort === "priority") return matches.sort(byPriority);
  if (sort === "title")
    return matches.sort((a, b) => a.title.localeCompare(b.title, "ko"));
  return matches.sort((a, b) =>
    sort === "oldest"
      ? a.date.localeCompare(b.date)
      : b.date.localeCompare(a.date),
  );
}
