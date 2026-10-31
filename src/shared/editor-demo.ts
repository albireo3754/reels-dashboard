import {
  defaultEditSettings,
  followCoverDefaults,
  type EditorBridge,
  type EditorProject,
  type RenderJob,
} from "./editor";

import { validateEditSettings } from "./editor-model";

// Generated from a solid-colour FFmpeg source; never a personal library asset.
export const demoVideo =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAn0bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAALuAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAACR50cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAALuAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAWgAAAKAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAC7gAAAIAAABAAAAAAiWbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAACQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAIQW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAACAFzdGJsAAAAwXN0c2QAAAAAAAAAAQAAALFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAWgCgABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAN2F2Y0MBZAAW/+EAGmdkABas2UFwUeXwEQAAAwABAAADABgPFi2WAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApsAAAAAAAAABhzdHRzAAAAAAAAAAEAAACQAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAEiGN0dHMAAAAAAAAAjwAAAAEAAAgAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABAAAAAAAgAABAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAJAAAAABAAACVHN0c3oAAAAAAAAAAAAAAJAAAAOhAAAAFQAAABMAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAGwAAABUAAAATAAAAEwAAABsAAAAVAAAAEwAAABMAAAAbAAAAFQAAABMAAAATAAAAHAAAABUAAAATAAAAEwAAABwAAAAVAAAAEwAAABMAAAAcAAAAFQAAABMAAAATAAAAHAAAABUAAAATAAAAEwAAABwAAAAVAAAAEwAAABMAAAAaAAAAFQAAABMAAAAUc3RjbwAAAAAAAAABAAAKJAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAwAAAACGZyZWUAAA+qbWRhdAAAAq8GBf//q9xF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xMiBsb29rYWhlYWRfdGhyZWFkcz0yIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTIgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAADqZYiEABH//ufj/ApFgsMcU7WtbXcqLo14dXGIU8gujMZH9fUAAAMBln4PM5TlzOIbAgA/QAAVcWTBPWwqSVGsgJKUskQh/v5bGUBz+F+gC1KdBrvSUSXL0Zzui31OCwqqmLB7af7Fw9D49pyh5j8OUJrJ+VUUneL92Rg9C83KcURAxQRhSe+mLig8W3MpBSHd1OMPpX1EBt54bkfrGD/vLecAIfhLM494chHgIK1YAAADAAADAAADAA0Xu4ngEF/x3dpf2XlufOOSiY1rEUCMsms9+BOi0AAiTGHwAAADAAADAAADAAADAAQdAAAAEUGaJGxBH/61KoAAAAMAAB1QAAAAD0GeQniG/wAAAwAAAwCkgQAAAA8BnmF0Qz8AAAMAAAMAyoAAAAAPAZ5jakM/AAADAAADAMqBAAAAF0GaaEmoQWiZTAgj//61KoAAAAMAAB1RAAAAEUGehkURLDf/AAADAAADAKSBAAAADwGepXRDPwAAAwAAAwDKgQAAAA8BnqdqQz8AAAMAAAMAyoAAAAAXQZqsSahBbJlMCCP//rUqgAAAAwAAHVAAAAARQZ7KRRUsN/8AAAMAAAMApIEAAAAPAZ7pdEM/AAADAAADAMqAAAAADwGe62pDPwAAAwAAAwDKgAAAABdBmvBJqEFsmUwII//+tSqAAAADAAAdUQAAABFBnw5FFSw3/wAAAwAAAwCkgQAAAA8Bny10Qz8AAAMAAAMAyoEAAAAPAZ8vakM/AAADAAADAMqAAAAAF0GbNEmoQWyZTAgj//61KoAAAAMAAB1QAAAAEUGfUkUVLDf/AAADAAADAKSBAAAADwGfcXRDPwAAAwAAAwDKgAAAAA8Bn3NqQz8AAAMAAAMAyoAAAAAXQZt4SahBbJlMCCP//rUqgAAAAwAAHVEAAAARQZ+WRRUsN/8AAAMAAAMApIAAAAAPAZ+1dEM/AAADAAADAMqBAAAADwGft2pDPwAAAwAAAwDKgQAAABdBm7xJqEFsmUwII//+tSqAAAADAAAdUAAAABFBn9pFFSw3/wAAAwAAAwCkgQAAAA8Bn/l0Qz8AAAMAAAMAyoAAAAAPAZ/7akM/AAADAAADAMqBAAAAF0Gb4EmoQWyZTAgj//61KoAAAAMAAB1RAAAAEUGeHkUVLDf/AAADAAADAKSAAAAADwGePXRDPwAAAwAAAwDKgAAAAA8Bnj9qQz8AAAMAAAMAyoEAAAAXQZokSahBbJlMCCP//rUqgAAAAwAAHVAAAAARQZ5CRRUsN/8AAAMAAAMApIEAAAAPAZ5hdEM/AAADAAADAMqAAAAADwGeY2pDPwAAAwAAAwDKgQAAABdBmmhJqEFsmUwII//+tSqAAAADAAAdUQAAABFBnoZFFSw3/wAAAwAAAwCkgQAAAA8BnqV0Qz8AAAMAAAMAyoEAAAAPAZ6nakM/AAADAAADAMqAAAAAF0GarEmoQWyZTAgj//61KoAAAAMAAB1QAAAAEUGeykUVLDf/AAADAAADAKSBAAAADwGe6XRDPwAAAwAAAwDKgAAAAA8BnutqQz8AAAMAAAMAyoAAAAAXQZrwSahBbJlMCCP//rUqgAAAAwAAHVEAAAARQZ8ORRUsN/8AAAMAAAMApIEAAAAPAZ8tdEM/AAADAAADAMqBAAAADwGfL2pDPwAAAwAAAwDKgAAAABdBmzRJqEFsmUwII//+tSqAAAADAAAdUAAAABFBn1JFFSw3/wAAAwAAAwCkgQAAAA8Bn3F0Qz8AAAMAAAMAyoAAAAAPAZ9zakM/AAADAAADAMqAAAAAF0GbeEmoQWyZTAgj//61KoAAAAMAAB1RAAAAEUGflkUVLDf/AAADAAADAKSAAAAADwGftXRDPwAAAwAAAwDKgQAAAA8Bn7dqQz8AAAMAAAMAyoEAAAAXQZu8SahBbJlMCCP//rUqgAAAAwAAHVAAAAARQZ/aRRUsN/8AAAMAAAMApIEAAAAPAZ/5dEM/AAADAAADAMqAAAAADwGf+2pDPwAAAwAAAwDKgQAAABdBm+BJqEFsmUwII//+tSqAAAADAAAdUQAAABFBnh5FFSw3/wAAAwAAAwCkgAAAAA8Bnj10Qz8AAAMAAAMAyoAAAAAPAZ4/akM/AAADAAADAMqBAAAAF0GaJEmoQWyZTAgj//61KoAAAAMAAB1QAAAAEUGeQkUVLDf/AAADAAADAKSBAAAADwGeYXRDPwAAAwAAAwDKgAAAAA8BnmNqQz8AAAMAAAMAyoEAAAAXQZpoSahBbJlMCCP//rUqgAAAAwAAHVEAAAARQZ6GRRUsN/8AAAMAAAMApIEAAAAPAZ6ldEM/AAADAAADAMqBAAAADwGep2pDPwAAAwAAAwDKgAAAABdBmqxJqEFsmUwII//+tSqAAAADAAAdUAAAABFBnspFFSw3/wAAAwAAAwCkgQAAAA8Bnul0Qz8AAAMAAAMAyoAAAAAPAZ7rakM/AAADAAADAMqAAAAAF0Ga8EmoQWyZTAgj//61KoAAAAMAAB1RAAAAEUGfDkUVLDf/AAADAAADAKSBAAAADwGfLXRDPwAAAwAAAwDKgQAAAA8Bny9qQz8AAAMAAAMAyoAAAAAXQZs0SahBbJlMCCP//rUqgAAAAwAAHVAAAAARQZ9SRRUsN/8AAAMAAAMApIEAAAAPAZ9xdEM/AAADAAADAMqAAAAADwGfc2pDPwAAAwAAAwDKgAAAABdBm3hJqEFsmUwII//+tSqAAAADAAAdUQAAABFBn5ZFFSw3/wAAAwAAAwCkgAAAAA8Bn7V0Qz8AAAMAAAMAyoEAAAAPAZ+3akM/AAADAAADAMqBAAAAF0GbvEmoQWyZTAgj//61KoAAAAMAAB1QAAAAEUGf2kUVLDf/AAADAAADAKSBAAAADwGf+XRDPwAAAwAAAwDKgAAAAA8Bn/tqQz8AAAMAAAMAyoEAAAAXQZvgSahBbJlMCCP//rUqgAAAAwAAHVEAAAARQZ4eRRUsN/8AAAMAAAMApIAAAAAPAZ49dEM/AAADAAADAMqAAAAADwGeP2pDPwAAAwAAAwDKgQAAABdBmiRJqEFsmUwII//+tSqAAAADAAAdUAAAABFBnkJFFSw3/wAAAwAAAwCkgQAAAA8BnmF0Qz8AAAMAAAMAyoAAAAAPAZ5jakM/AAADAAADAMqBAAAAF0GaaEmoQWyZTAgj//61KoAAAAMAAB1RAAAAEUGehkUVLDf/AAADAAADAKSBAAAADwGepXRDPwAAAwAAAwDKgQAAAA8BnqdqQz8AAAMAAAMAyoAAAAAXQZqsSahBbJlMCCP//rUqgAAAAwAAHVAAAAARQZ7KRRUsN/8AAAMAAAMApIEAAAAPAZ7pdEM/AAADAAADAMqAAAAADwGe62pDPwAAAwAAAwDKgAAAABdBmvBJqEFsmUwII//+tSqAAAADAAAdUQAAABFBnw5FFSw3/wAAAwAAAwCkgQAAAA8Bny10Qz8AAAMAAAMAyoEAAAAPAZ8vakM/AAADAAADAMqAAAAAF0GbNEmoQWyZTAgj//61KoAAAAMAAB1QAAAAEUGfUkUVLDf/AAADAAADAKSBAAAADwGfcXRDPwAAAwAAAwDKgAAAAA8Bn3NqQz8AAAMAAAMAyoAAAAAXQZt4SahBbJlMCCP//rUqgAAAAwAAHVEAAAARQZ+WRRUsN/8AAAMAAAMApIAAAAAPAZ+1dEM/AAADAAADAMqBAAAADwGft2pDPwAAAwAAAwDKgQAAABhBm7xJqEFsmUwIIf/+qlUAAAMAAAMAOqAAAAARQZ/aRRUsN/8AAAMAAAMApIEAAAAPAZ/5dEM/AAADAAADAMqAAAAADwGf+2pDPwAAAwAAAwDKgQAAABhBm+BJqEFsmUwIIf/+qlUAAAMAAAMAOqEAAAARQZ4eRRUsN/8AAAMAAAMApIAAAAAPAZ49dEM/AAADAAADAMqAAAAADwGeP2pDPwAAAwAAAwDKgQAAABhBmiRJqEFsmUwIIf/+qlUAAAMAAAMAOqAAAAARQZ5CRRUsN/8AAAMAAAMApIEAAAAPAZ5hdEM/AAADAAADAMqAAAAADwGeY2pDPwAAAwAAAwDKgQAAABhBmmhJqEFsmUwIIf/+qlUAAAMAAAMAOqEAAAARQZ6GRRUsN/8AAAMAAAMApIEAAAAPAZ6ldEM/AAADAAADAMqBAAAADwGep2pDPwAAAwAAAwDKgAAAABhBmqxJqEFsmUwIf//+qZYAAAMAAAMA5YAAAAARQZ7KRRUsN/8AAAMAAAMApIEAAAAPAZ7pdEM/AAADAAADAMqAAAAADwGe62pDPwAAAwAAAwDKgAAAABZBmu9JqEFsmUwIZ//+nhAAAAMAAAb1AAAAEUGfDUUVLDf/AAADAAADAKSBAAAADwGfLmpDPwAAAwAAAwDKgQ==";
const clone = <T>(value: T): T => structuredClone(value);
const escapeXML = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function createDemoEditor(
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
  search = typeof window === "undefined" ? "" : window.location.search,
  onStage?: (project: EditorProject, stage: "editing" | "review") => void,
): EditorBridge {
  const params = new URLSearchParams(search),
    key = "reels-editor-demo-v1";
  const projects = new Map<string, EditorProject>();
  const jobs = new Map<string, RenderJob>();
  try {
    const raw = storage?.getItem(key);
    if (raw) {
      const rows = JSON.parse(raw) as EditorProject[];
      for (const p of rows)
        if (p.schemaVersion === 1 && p.id && p.source && p.settings)
          projects.set(p.id, p);
    }
  } catch {
    /* Explicit demo state may be reset without affecting real projects. */
  }
  const persist = () =>
    storage?.setItem(key, JSON.stringify([...projects.values()]));
  const makeProject = (name = "예시 산책 영상.mp4"): EditorProject => ({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    source: {
      id: crypto.randomUUID(),
      name,
      duration: 12,
      width: 360,
      height: 640,
      hdr: params.get("demoHDR") === "1",
      hasAudio: false,
      videoURL: demoVideo,
    },
    settings: defaultEditSettings(12),
    updatedAt: new Date().toISOString(),
  });
  function validate(
    project: EditorProject,
    kind: "video" | "cover" | "export",
  ) {
    validateEditSettings(project.settings, project.source.duration, kind);
  }

  return {
    async runtime() {
      return {
        available: params.get("demoEditorUnavailable") !== "1",
        message: "예시 편집기예요. 실제 영상과 원본을 변경하지 않아요.",
      };
    },
    async chooseVideo() {
      const p = makeProject();
      projects.set(p.id, clone(p));
      persist();
      onStage?.(p, "editing");
      return p;
    },
    async fromPhotos(selection) {
      if (!selection.assetID || !selection.groupID || !selection.indexRunID)
        throw new Error("Photos 영상 선택을 확인해주세요.");
      const p = makeProject(`Photos 예시 ${selection.assetID}.mov`);
      projects.set(p.id, clone(p));
      persist();
      onStage?.(p, "editing");
      return p;
    },
    async list() {
      return [...projects.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((p) => ({
          id: p.id,
          name: p.source.name,
          updatedAt: p.updatedAt,
        }));
    },
    async load(id) {
      const p = projects.get(id);
      if (!p) throw new Error("편집 기록을 찾을 수 없어요.");
      return clone(p);
    },
    async save(project) {
      validateEditSettings(project.settings, project.source.duration, "draft");
      projects.set(project.id, clone(project));
      persist();
      onStage?.(project, "editing");
      return clone(project);
    },
    async preview(project, time, kind) {
      validate(project, kind);
      if (params.get("demoPreviewError") === "1")
        throw new Error("예시 미리보기 오류예요. 설정을 확인해주세요.");
      const { place, cover, captions } = project.settings;
      if (kind === "cover" && cover.template === "rosy-follow") {
        const lines = [
          ...cover.hook.split(/\n|\|/),
          cover.followCta ?? followCoverDefaults.cta,
          cover.followSignature ?? followCoverDefaults.signature,
        ];
        const markup = lines
          .map(
            (line, i) =>
              `<text x="25" y="${90 + i * 48}" fill="${i > 1 ? "#ffaabe" : "white"}" font-size="${i === 3 ? 18 : 24}">${escapeXML(line)}</text>`,
          )
          .join("");
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="#384348"/><text x="20" y="30" fill="white" font-size="12">DEMO · 예시 마지막 장</text>${markup}</svg>`)}`;
      }

      const title =
        kind === "cover"
          ? cover.hook.split(/\n|\|/)
          : captions.items
              .filter((c) => c.start <= time && c.end > time)
              .map((c) => c.text);
      const text = title
        .map(
          (line, i) =>
            `<text x="${kind === "cover" ? 25 : 180}" y="${kind === "cover" ? 380 + i * 38 : 430 + i * 30}" text-anchor="${kind === "cover" ? "start" : "middle"}" fill="white" font-size="${kind === "cover" ? 25 : 18}" font-family="sans-serif">${escapeXML(line)}</text>`,
        )
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="#7c947b"/><rect y="410" width="360" height="230" fill="#465f50"/><rect x="235" y="80" width="60" height="60" fill="#d9c99f"/><rect x="15" y="17" width="158" height="25" rx="5" fill="#233c32"/><text x="25" y="34" fill="#fff" font-size="11" font-family="sans-serif">DEMO · 예시 합성 이미지</text><text x="180" y="150" text-anchor="middle" fill="white" font-size="20" font-family="sans-serif">📍 ${escapeXML(place.name)}</text>${kind === "video" && place.material !== "none" ? `<rect x="25" y="165" width="310" height="34" fill="${place.material === "tape" ? "#e7dcc3" : "#222"}"/><text x="180" y="188" text-anchor="middle" fill="${place.material === "tape" ? "#343c30" : "white"}" font-size="13" font-family="sans-serif">${escapeXML(place.description)}</text>` : ""}${text}<text x="20" y="615" fill="#d2ddcc" font-size="11" font-family="sans-serif">${kind === "cover" ? "표지" : "영상"} · ${time.toFixed(2)}초 · 예시 데이터</text></svg>`;
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    },
    async export(project, target = "both") {
      validate(project, target === "cover" ? "cover" : "export");
      const job: RenderJob = {
        id: crypto.randomUUID(),
        projectId: project.id,
        state: "running",
        phase: "예시 렌더 시작",
        progress: 0,
      };
      job.phase =
        target === "cover" ? "예시 카드 이미지 합성" : "예시 렌더 시작";
      if (target === "cover") job.outputPath = "/demo/exports/card.png";
      jobs.set(job.id, job);
      return clone(job);
    },
    async job(id) {
      const job = jobs.get(id);
      if (!job) throw new Error("렌더 작업을 찾을 수 없어요.");
      if (job.state === "running") {
        job.progress = Math.min(100, job.progress + 20);
        job.phase = job.progress < 80 ? "예시 영상 합성" : "예시 표지 생성";
        if (params.get("demoRenderError") === "1" && job.progress >= 40) {
          job.state = "failed";
          job.error = "예시 렌더 오류예요.";
        } else if (job.progress === 100) {
          job.state = "completed";
          job.phase = "예시 내보내기 완료";
          job.outputPath ??= "/demo/exports/video.mp4";
          job.coverPath = "/demo/exports/cover.png";
          const project = projects.get(job.projectId);
          if (project) onStage?.(project, "review");
        }
      }
      return clone(job);
    },
    async cancel(id) {
      const job = jobs.get(id);
      if (!job) throw new Error("렌더 작업을 찾을 수 없어요.");
      if (job.state === "running") {
        job.state = "cancelled";
        job.phase = "예시 작업 취소";
      }
    },
    async reveal(id) {
      if (jobs.get(id)?.state !== "completed")
        throw new Error("완료된 결과가 없어요.");
    },
  };
}
