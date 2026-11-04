import type {
  DashboardBridge,
  LocalResource,
  Project,
} from "../shared/contracts";
import { ContentMediaCard, StageProgress } from "../features/content-board";
import { ContentRouteMap } from "../features/route-map";
import { ProjectAnalysis } from "../features/media-analysis";
import { Icon } from "./ui";

const dateBasisLabels: Record<NonNullable<Project["dateBasis"]>, string> = {
  capture: "촬영",
  publication: "게시",
  record: "기록",
};
const resourceRoleLabels: Record<LocalResource["role"], string> = {
  footage: "촬영본",
  final: "완성본",
  cover: "표지",
  draft: "시안",
  document: "문서",
  folder: "폴더",
};

/** One content card on the dashboard board. */
export function ProjectCard({
  project,
  bridge,
  index,
  readOnly,
  busy,
  onEdit,
  onReveal,
}: {
  project: Project;
  bridge: DashboardBridge;
  index: number;
  readOnly: boolean;
  busy: boolean;
  onEdit: () => void;
  onReveal?: (path: string) => void;
}) {
  const resources = project.resources ?? [];
  return (
    <article className="project-card">
      <ContentMediaCard
        key={project.id + JSON.stringify(project.resources)}
        project={project}
        bridge={bridge}
        index={index}
      />
      <div className="project-body">
        <ContentRouteMap project={project} bridge={bridge} />
        <ProjectAnalysis project={project} bridge={bridge} />
        <span className="project-date">
          {project.dateBasis ? `${dateBasisLabels[project.dateBasis]} ` : ""}
          {project.date || "날짜 미정"}
          {project.shared && (
            <span className="share-indicator">모바일 공유</span>
          )}
        </span>
        <h3>{project.title}</h3>
        <StageProgress project={project} />
        <p>{project.nextAction || "다음 할 일을 정해보세요."}</p>
        {!readOnly && resources.length > 0 && (
          <details className="local-resources">
            <summary>연결 자료 {resources.length}개</summary>
            {project.localNotes && <p>{project.localNotes}</p>}
            <ul>
              {resources.map((resource) => (
                <li key={`${resource.role}:${resource.path}`}>
                  <span>
                    {resourceRoleLabels[resource.role]} · {resource.label}
                  </span>
                  <button
                    disabled={!onReveal || busy}
                    onClick={() => onReveal?.(resource.path)}
                  >
                    위치 열기
                  </button>
                  <small className="resource-path">{resource.path}</small>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="project-footer">
          {project.publicURL ? (
            <a href={project.publicURL} target="_blank" rel="noreferrer">
              게시물 보기 ↗
            </a>
          ) : (
            <span>
              {project.stage === "published"
                ? "게시 링크를 추가해주세요."
                : "작업을 이어가요"}
            </span>
          )}
          {!readOnly && (
            <button
              className="icon-button"
              aria-label={`${project.title} 수정`}
              onClick={onEdit}
            >
              <Icon name="arrow" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
