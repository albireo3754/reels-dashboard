export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
}
export interface EditSettings {
  place: {
    useDefaultPosition: boolean;
    name: string;
    description: string;
    material: "none" | "tape" | "rectangle";
    x: number;
    y: number;
    size: number;
    persistent: boolean;
    showDuring: string;
  };
  captions: { fontSizeRatio: number; y: number; items: CaptionCue[] };
  cover: {
    useDefaultPosition: boolean;
    time: number;
    hook: string;
    template: "rosy-auto" | "rosy-large";
    x: number;
    y: number;
    placeX: number;
    placeY: number;
    hookSize?: number;
  };
}
export interface EditorSource {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  hdr: boolean;
  hasAudio: boolean;
  videoURL: string;
}
export interface EditorProject {
  schemaVersion: 1;
  id: string;
  source: EditorSource;
  settings: EditSettings;
  updatedAt: string;
}
export interface EditorSummary {
  id: string;
  name: string;
  updatedAt: string;
}
export interface RenderJob {
  id: string;
  projectId: string;
  state: "running" | "completed" | "cancelled" | "failed";
  phase: string;
  progress: number;
  error?: string;
  outputPath?: string;
  coverPath?: string;
  manifestPaths?: string[];
}
export interface EditorBridge {
  runtime(): Promise<{ available: boolean; message: string }>;
  chooseVideo(): Promise<EditorProject | null>;
  fromPhotos(selection: {
    groupID: string;
    indexRunID: string;
    assetID: string;
  }): Promise<EditorProject>;
  list(): Promise<EditorSummary[]>;
  load(id: string): Promise<EditorProject>;
  save(project: EditorProject): Promise<EditorProject>;
  preview(
    project: EditorProject,
    time: number,
    kind: "video" | "cover",
  ): Promise<string>;
  export(project: EditorProject): Promise<RenderJob | null>;
  job(id: string): Promise<RenderJob>;
  cancel(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
}
export function defaultEditSettings(duration: number): EditSettings {
  return {
    place: {
      useDefaultPosition: true,
      name: "",
      description: "",
      material: "tape",
      x: 0.5,
      y: 0.24,
      size: 0.042,
      persistent: true,
      showDuring: "",
    },
    captions: { fontSizeRatio: 0.045, y: 0.65, items: [] },
    cover: {
      useDefaultPosition: true,
      time: 0,
      hook: "",
      template: "rosy-auto",
      x: 0.07,
      y: 0.6,
      placeX: 0.5,
      placeY: 0.21,
    },
  };
}

export interface AgentUiBridge {
  reportContext(context: {
    projectId: string | null;
    dirty: boolean;
    time: number;
    active: boolean;
    busy: boolean;
  }): Promise<void>;
  onProjectChanged(callback: (project: EditorProject) => void): () => void;
  onProjectOpened(callback: (project: EditorProject) => void): () => void;
  onRenderStarted(callback: (job: RenderJob) => void): () => void;
}
