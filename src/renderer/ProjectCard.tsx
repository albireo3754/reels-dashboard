import { ClipUploadControls } from "./ClipUploadControls";
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

/**
 * One content card on the dashboard board. The poster is the card's subject;
 * secondary actions (촬영 지도, 메타데이터 분석, 클립 업로드 묶음, 수정) stay in the DOM but only
 * show on hover or keyboard focus (.ui-hover-reveal; always shown on touch).
 */
export function ProjectCard({
  project,
  bridge,
  readOnly,
  busy,
  onEdit,
  onReveal,
}: {
  project: Project;
  bridge: DashboardBridge;
  readOnly: boolean;
  busy: boolean;
  onEdit: () => void;
  onReveal?: (path: string) => void;
}) {
  const resources = project.resources ?? [];
  return (
    <article className="project-card ui-hover-host">
      <ContentMediaCard
        key={project.id + JSON.stringify(project.resources)}
        project={project}
        bridge={bridge}
      />
      <div className="project-body">
        <div className="project-title-row">
          <h3>{project.title}</h3>
          {!readOnly && (
            <button
              className="icon-button small ui-hover-reveal"
              aria-label={`${project.title} 수정`}
              title="수정"
              onClick={onEdit}
            >
              <Icon name="edit" />
            </button>
          )}
        </div>
        <p className="project-meta">
          <span>
            {project.dateBasis ? `${dateBasisLabels[project.dateBasis]} ` : ""}
            {project.date || "날짜 미정"}
          </span>
          {project.shared && <span className="share-indicator">모바일 공유</span>}
          {project.publicURL && (
            <a href={project.publicURL} target="_blank" rel="noreferrer">
              게시물 보기 ↗
            </a>
          )}
        </p>
        <StageProgress project={project} />
        <p className="project-next">
          {project.nextAction || "다음 할 일을 정해보세요."}
        </p>
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
                    className="small"
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
        <div className="project-actions ui-hover-reveal">
          <ContentRouteMap project={project} bridge={bridge} />
          <ProjectAnalysis project={project} bridge={bridge} />
          {!readOnly && <ClipUploadControls bridge={bridge} project={project} />}
        </div>
      </div>
    </article>
  );
}
