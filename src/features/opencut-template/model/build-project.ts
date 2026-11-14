import type { OpenCutRecipe } from "./recipe";
import type { OpenCutTemplate } from "./template";

export interface OpenCutMedia {
  id: string;
  name: string;
  type: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** No module dependencies in the body: the same builder runs in the browser package. */
export function buildOpenCutProject(
  seed: any,
  media: OpenCutMedia[],
  recipe: OpenCutRecipe,
  style: OpenCutTemplate,
) {
  if (seed.version !== style.schemaVersion)
    throw new Error("OpenCut schema changed; inspect before applying.");
  if (recipe.templateId !== style.id) throw new Error("Template mismatch");
  const project = structuredClone(seed);
  const scene = project.scenes.find(
    (s: any) => s.id === project.currentSceneId,
  );
  if (!scene) throw new Error("OpenCut main scene missing");
  const tracks = scene.tracks;
  const elements = [tracks.main, ...tracks.overlay].flatMap(
    (t: any) => t.elements,
  );
  const textBase = elements.find((e: any) => e.type === "text");
  if (!textBase)
    throw new Error("Add one default text element in OpenCut first.");
  let cursor = 0;
  const cuts = recipe.cuts.map((c) => {
    const matches = media.filter((m) => m.name === c.file);
    if (matches.length !== 1)
      throw new Error(`Missing or duplicate imported media: ${c.file}`);
    const m = matches[0];
    if (!["video", "image"].includes(m.type))
      throw new Error(`Unsupported media: ${c.file}`);
    if (
      m.type === "image" &&
      (c.length > style.maxStillSeconds || c.sourceIn !== 0 || c.rate !== 1)
    )
      throw new Error(
        `Still image must be ≤${style.maxStillSeconds}s without trim/speed: ${c.file}`,
      );
    if (
      m.type === "video" &&
      (!Number.isFinite(m.duration) ||
        c.sourceIn + c.length * c.rate > m.duration! + 0.001)
    )
      throw new Error(`Cut exceeds source: ${c.file}`);
    const base = elements.find((e: any) => e.type === m.type);
    if (!base) throw new Error(`Add one ${m.type} element in OpenCut first.`);
    const e = structuredClone(base);
    // Content-specific effects, animation and old retiming must not leak into a new recipe.
    for (const key of ["effects", "animations", "keyframes", "masks", "retime"])
      delete e[key];
    Object.assign(e, {
      id: crypto.randomUUID(),
      name: c.file,
      mediaId: m.id,
      startTime: Math.round(cursor * 120000),
      duration: Math.round(c.length * 120000),
      trimStart: Math.round(c.sourceIn * 120000),
      trimEnd: 0,
      hidden: false,
      opacity: 1,
      blendMode: "normal",
      transform: {
        scaleX: c.scale,
        scaleY: c.scale,
        position: { x: c.x, y: c.y },
        rotate: 0,
      },
    });
    if (m.type === "video")
      Object.assign(e, {
        sourceDuration: Math.round(m.duration! * 120000),
        trimEnd: Math.round(
          (m.duration! - c.sourceIn - c.length * c.rate) * 120000,
        ),
        muted: true,
        isSourceAudioEnabled: false,
        volume: 0,
        retime: { rate: c.rate, maintainPitch: false },
      });
    cursor += c.length;
    return e;
  });
  const edge = "titleOnEdgesSeconds" in style ? style.titleOnEdgesSeconds : 0;
  const headerWindows =
    edge > 0 && cursor > edge * 2
      ? [{ start: 0, end: edge }, { start: cursor - edge, end: cursor }]
      : [{ start: 0, end: cursor }];
  const layers = [
    {
      name: "상단 제목",
      style: style.layers.title,
      cues: headerWindows.map((window) => ({ ...window, text: recipe.title })),
    },
    {
      name: "상단 장소",
      style: style.layers.place,
      cues: headerWindows.map((window) => ({ ...window, text: recipe.place })),
    },
    { name: "본문 자막", style: style.layers.caption, cues: recipe.captions },
    { name: "부가 정보", style: style.layers.note, cues: recipe.notes },
  ];
  tracks.overlay = layers
    .filter((l) => l.cues.length)
    .map((l) => ({
      id: crypto.randomUUID(),
      name: l.name,
      type: "text",
      hidden: false,
      elements: l.cues.map((c) => {
        const e = structuredClone(textBase);
        for (const key of [
          "effects",
          "animations",
          "keyframes",
          "masks",
          "retime",
        ])
          delete e[key];
        return Object.assign(e, {
          id: crypto.randomUUID(),
          name: c.text.replaceAll("\n", " "),
          content: c.text,
          startTime: Math.round(c.start * 120000),
          duration: Math.round((c.end - c.start) * 120000),
          trimStart: 0,
          trimEnd: 0,
          fontSize: l.style.size,
          fontFamily: "Apple SD Gothic Neo",
          fontWeight: "bold",
          fontStyle: "normal",
          color: l.style.color,
          textAlign: "center",
          textDecoration: "none",
          letterSpacing: 0,
          lineHeight: 1.2,
          background: {
            enabled: true,
            color: l.style.background,
            cornerRadius: 6,
            paddingX: 36,
            paddingY: 22,
            offsetX: 0,
            offsetY: 0,
          },
          transform: {
            scaleX: l.style.scale,
            scaleY: l.style.scale,
            position: { x: 0, y: l.style.y },
            rotate: 0,
          },
          hidden: false,
          opacity: 1,
          blendMode: "normal",
        });
      }),
    }));
  Object.assign(tracks.main, { elements: cuts, muted: true, hidden: false });
  tracks.audio = [];
  Object.assign(project.settings, {
    canvasSize: { ...style.canvas },
    originalCanvasSize: { ...style.canvas },
    canvasSizeMode: "preset",
    fps: { numerator: style.fps, denominator: 1 },
    background: { type: "color", color: "#000000" },
  });
  project.metadata.name = `${recipe.place} · ${style.name}`;
  project.metadata.duration = Math.round(cursor * 120000);
  project.metadata.updatedAt = new Date().toISOString();
  scene.updatedAt = project.metadata.updatedAt;
  project.timelineViewState = {
    ...project.timelineViewState,
    playheadTime: 0,
    scrollLeft: 0,
  };
  return project;
}
