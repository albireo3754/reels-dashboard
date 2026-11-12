import {
  projectStages,
  type Project,
  type Stage,
} from "../../../shared/contracts";
import {
  isPublishedOn,
  publicationChannelLabels,
  publicationChannels,
  publicationOn,
  type PublicationChannel,
} from "../../../shared/publications";

export const channelLabels = {
  all: "모든 채널",
  ...publicationChannelLabels,
};

export const sortLabels = {
  newest: "날짜 최신순",
  oldest: "날짜 오래된순",
  title: "제목 가나다순",
  priority: "작업 우선순",
};
export const basisLabels = {
  all: "모든 날짜",
  publication: "게시일",
  capture: "촬영일",
  record: "기록일",
  unknown: "기준 미지정",
};
export type BoardQuery = {
  search: string;
  stage: "all" | "active" | Stage;
  basis: keyof typeof basisLabels;
  /** One channel narrows the board to projects that target it and judges progress by that channel alone. */
  channel: "all" | PublicationChannel;
  sort: keyof typeof sortLabels;
  view: "grid" | "list";
};
export const defaultBoardQuery: BoardQuery = {
  search: "",
  stage: "active",
  basis: "all",
  channel: "all",
  sort: "newest",
  view: "grid",
};
export function parseBoardQuery(value: unknown): BoardQuery {
  const result = { ...defaultBoardQuery };
  if (!value || typeof value !== "object") return result;
  const v = value as Record<string, unknown>;
  if (typeof v.search === "string") result.search = v.search.slice(0, 300);
  if (["all", "active", ...projectStages].includes(String(v.stage)))
    result.stage = v.stage as BoardQuery["stage"];
  if (Object.hasOwn(basisLabels, String(v.basis)))
    result.basis = v.basis as BoardQuery["basis"];
  if ((publicationChannels as readonly string[]).includes(String(v.channel)))
    result.channel = v.channel as PublicationChannel;
  if (Object.hasOwn(sortLabels, String(v.sort)))
    result.sort = v.sort as BoardQuery["sort"];
  if (v.view === "list") result.view = "list";
  return result;
}
const normalize = (v: string) => v.normalize("NFKC").toLocaleLowerCase("ko");
const priority: Record<Stage, number> = {
  review: 0,
  editing: 1,
  selected: 2,
  captured: 3,
  idea: 4,
  published: 5,
};
export function selectBoardProjects(
  projects: Project[],
  query: BoardQuery,
): Project[] {
  const words = normalize(query.search).trim().split(/\s+/).filter(Boolean);
  const channel = query.channel;
  const selected = projects.filter((project) => {
    if (channel !== "all") {
      if (!publicationOn(project, channel)) return false;
      // In a channel view "published" means live on that channel, whatever the other channels are doing.
      const live = isPublishedOn(project, channel);
      if (query.stage === "active" ? live : query.stage === "published" && !live)
        return false;
      if (
        !["all", "active", "published"].includes(query.stage) &&
        (live || project.stage !== query.stage)
      )
        return false;
    } else if (
      query.stage === "active"
        ? project.stage === "published"
        : query.stage !== "all" && project.stage !== query.stage
    )
      return false;
    if (
      query.basis !== "all" &&
      (project.dateBasis ?? "unknown") !== query.basis
    )
      return false;
    const text = normalize(
      [
        project.title,
        project.nextAction,
        project.localNotes,
        ...(project.resources ?? []).map((r) => r.label),
      ].join(" "),
    );
    return words.every((word) => text.includes(word));
  });
  return selected.sort((a, b) => {
    const title = () =>
      a.title.localeCompare(b.title, "ko", { numeric: true }) ||
      a.id.localeCompare(b.id);
    if (query.sort === "title") return title();
    if (query.sort === "priority" && a.stage !== b.stage)
      return priority[a.stage] - priority[b.stage];
    // Missing dates stay last in both directions; record dates are never treated as publication dates.
    if (!a.date || !b.date) return Number(!a.date) - Number(!b.date) || title();
    const date = a.date.localeCompare(b.date);
    return (query.sort === "oldest" ? date : -date) || title();
  });
}
