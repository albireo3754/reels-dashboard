import type {
  EditorBridge,
  EditorProject,
  EditSettings,
  RenderJob,
} from "../../../shared/editor";
import type {
  CommandMethod,
  Arguments,
  Dashboard,
} from "../../../shared/contracts";
import { AgentSession, patchProject } from "../../../entities/agent-session";
import { toolDefinitions, type ToolName } from "../model/tools";

export interface AgentEditorPort extends EditorBridge {
  busy: boolean;
  importVideo(path: string, settings?: EditSettings): Promise<EditorProject>;
  activeJobs(): RenderJob[];
  previewArtifact(
    project: EditorProject,
    time: number,
    kind: "video" | "cover",
  ): Promise<{ image: string; manifest: unknown }>;
  render(
    project: EditorProject,
    output: string,
    target: "video" | "cover" | "both",
  ): Promise<RenderJob | null>;
}
export interface AgentPorts {
  editor: AgentEditorPort;
  session: AgentSession;
  dashboard(): Promise<Dashboard>;
  preview(
    project: EditorProject,
    time: number,
    kind: "video" | "cover",
  ): Promise<{
    image: string;
    manifest: unknown;
    displaySize: { width: number; height: number };
  }>;
  open(project: EditorProject): void;
  photos(method: CommandMethod, args: Arguments): Promise<unknown>;
}
export function createAgentDispatch(ports: AgentPorts) {
  const { editor, session } = ports;
  async function current(id: string, expected: string) {
    session.assertWritable(id);
    const project = await editor.load(id);
    if (project.updatedAt !== expected)
      throw new Error("STALE_PROJECT: 프로젝트를 다시 조회해주세요.");
    return project;
  }
  return async (name: string, args: unknown): Promise<unknown> => {
    if (!Object.hasOwn(toolDefinitions, name))
      throw new Error("UNKNOWN_TOOL: 지원하지 않는 도구예요.");
    const input = toolDefinitions[name as ToolName].input.parse(args) as any;
    switch (name as ToolName) {
      case "reels_get_app_state":
        return {
          context: session.context,
          busy: editor.busy,
          runtime: await editor.runtime(),
          jobs: editor.activeJobs(),
        };
      case "reels_list_projects":
        return {
          editorProjects: await editor.list(),
          dashboard: await ports.dashboard(),
        };
      case "reels_get_project":
        return editor.load(input.projectId);
      case "reels_open_project": {
        session.assertWritable();
        if (editor.busy)
          throw new Error(
            "EDITOR_BUSY: 진행 중인 편집 작업을 마친 뒤 열어주세요.",
          );
        const project = await editor.load(input.projectId);
        ports.open(project);
        return project;
      }
      case "reels_import_video": {
        const reuse = input.reuse
          ? await current(input.reuse.projectId, input.reuse.expectedUpdatedAt)
          : undefined;
        return editor.importVideo(input.sourcePath, reuse?.settings);
      }
      case "reels_update_project": {
        const project = await current(input.projectId, input.expectedUpdatedAt);
        return editor.save(
          patchProject(project, input.expectedUpdatedAt, input.patch),
        );
      }
      case "reels_preview_frame": {
        const project = await current(input.projectId, input.expectedUpdatedAt);
        const time =
          input.kind === "cover" ? project.settings.cover.time : input.time;
        if (time === undefined)
          throw new Error("영상 미리보기에는 time이 필요해요.");
        return ports.preview(project, time, input.kind);
      }
      case "reels_start_render":
        return editor.render(
          await current(input.projectId, input.expectedUpdatedAt),
          input.outputPath,
          input.target,
        );
      case "reels_get_render_job":
        return editor.job(input.jobId);
      case "reels_cancel_render":
        await editor.job(input.jobId);
        await editor.cancel(input.jobId);
        return editor.job(input.jobId);
      case "reels_list_templates":
        return {
          cover: [
            {
              id: "rosy-auto",
              sizing: "two-line shared size fitted to 80% width",
              alignment: "left",
              x: 0.07,
            },
            {
              id: "rosy-large",
              hookSize: 185,
              referenceWidth: 2160,
              alignment: "left",
              x: 0.07,
            },
          ],
          place: {
            materials: ["none", "tape", "rectangle"],
            group: "pin and description share one horizontal center",
            defaultX: 0.5,
          },
          semantics:
            "Cover hook/signature, place guide, and body captions are independent. Existing source text/audio is preserved; no automatic color grading or timeline cuts.",
        };
      case "reels_photos_status":
        return ports.photos("status", {});
      case "reels_photos_index":
        return ports.photos("sync", { date: input.date });
      case "reels_photos_groups":
        return ports.photos("groups.list", { level: input.level });
      case "reels_photos_group":
        return ports.photos("groups.show", {
          id: input.groupId,
          "index-run": input.indexRunId,
        });
      case "reels_photos_inspect":
        return ports.photos("groups.inspect", {
          id: input.groupId,
          "index-run": input.indexRunId,
          page: String(input.page),
          "page-size": String(input.pageSize),
          samples: String(input.pageSize),
        });
      case "reels_import_photos_video":
        return editor.fromPhotos({
          groupID: input.groupId,
          indexRunID: input.indexRunId,
          assetID: input.assetId,
        });
    }
  };
}
