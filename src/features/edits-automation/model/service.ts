import { copyFile, readdir, stat, access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  editsTools,
  editsScreenLockState,
  axLabel,
  matchesAX,
  type AXNode,
  type AXSnapshot,
  type AXSelector,
  type EditsBridge,
  type EditsNativePort,
  type EditsToolName,
  type EditsNativeOperation,
} from "../../../shared/edits";
import {
  readEditsProject,
  readEditsMedia,
  verifyEditsMediaSource,
  type EditsProject,
  type EditsMedia,
  type MediaProof,
} from "./project";

type Options = {
  project?: (snapshot: AXSnapshot, id?: string) => Promise<EditsProject | null>;
  media?: (projectId: string) => Promise<EditsMedia[]>;
  verifyMedia?: (
    media: EditsMedia,
    input: string,
  ) => Promise<MediaProof | null>;
  exportRoot?: string;
  pollMs?: number;
  timeoutMs?: number;
};
const closeEnough = (a: number, b: number) =>
  Math.abs(a - b) <= 1 / 60 + 0.0001;
const forbidden =
  /share to instagram|publish|sign.?in|log.?in|password|delete account/i;
const projectID = /^[0-9a-f-]{36}$/i;

/** App-owned workflow; one operation at a time, reads may poll, writes never replay. */
export class EditsAutomation implements EditsBridge {
  private busy = false;
  private evidence: unknown[] = [];
  private project: NonNullable<Options["project"]>;
  private media: NonNullable<Options["media"]>;
  private verifyMedia: NonNullable<Options["verifyMedia"]>;
  constructor(
    private native: EditsNativePort,
    private options: Options = {},
  ) {
    this.project = options.project ?? readEditsProject;
    this.media = options.media ?? readEditsMedia;
    this.verifyMedia = options.verifyMedia ?? verifyEditsMediaSource;
  }
  async request(name: EditsToolName, input: unknown): Promise<unknown> {
    const args = editsTools[name].input.parse(input) as any;
    if (this.busy)
      throw new Error(
        "EDITS_BUSY: another Edits operation is running; no request was applied",
      );
    this.busy = true;
    this.evidence = [];
    try {
      if (args.dryRun) {
        const status = await this.status();
        return {
          dryRun: true,
          attempted: false,
          verified: false,
          status,
          plan: { tool: name, args },
          note: "Plan only; no press, key, set-value, menu, drag, export or output copy was performed.",
        };
      }
      return await this.run(name, args);
    } catch (error) {
      if (error instanceof Error) {
        const code = error.message.match(/^([A-Z][A-Z0-9_]+)(?::|$)/)?.[1];
        Object.assign(error, {
          editsEvidence: this.evidence,
          ...(code ? { code } : {}),
        });
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private async status() {
    const status = await this.native.invoke("status", {});
    const state = editsScreenLockState.safeParse(status?.screenLocked);
    if (!state.success)
      throw new Error(
        "EDITS_HELPER_PROTOCOL: screenLocked must be boolean or unknown",
      );
    return { ...status, screenLocked: state.data };
  }
  private async action(
    op: EditsNativeOperation,
    args: Record<string, unknown>,
  ) {
    const result = await this.native.invoke(op, args);
    this.evidence.push({
      operation: op,
      attempted: result.attempted,
      verified: result.verified,
      verification: result.verification,
      fallback: result.fallback,
    });
    return result;
  }
  private async tree(requireComplete = true): Promise<AXSnapshot> {
    const snapshot = await this.native.invoke("tree", {
      depth: 16,
      maxNodes: 4000,
    });
    if (!Array.isArray(snapshot?.nodes) || typeof snapshot.pid !== "number")
      throw new Error("EDITS_HELPER_PROTOCOL: invalid snapshot");
    if (requireComplete && snapshot.truncated)
      throw Object.assign(
        new Error("EDITS_TREE_TRUNCATED: cannot safely select a write target"),
        { details: { diagnostics: snapshot.diagnostics } },
      );
    return snapshot;
  }
  private pick(snapshot: AXSnapshot, selector: AXSelector): AXNode {
    let nodes = snapshot.nodes.filter((node) => matchesAX(node, selector));
    if (nodes.length > 1) {
      // Known home title/thumbnail pair: choose the non-static thumbnail only.
      const interactive = nodes.filter((n) => n.role !== "AXStaticText");
      if (interactive.length === 1) nodes = interactive;
      else {
        // Export's duplicate ID is an ancestor/child chain, not arbitrary siblings.
        const deepest = [...nodes].sort(
          (a, b) => b.target.path.length - a.target.path.length,
        )[0];
        if (
          nodes.every(
            (n) =>
              n.target.root === deepest.target.root &&
              n.target.path.every((v, i) => deepest.target.path[i] === v),
          )
        )
          nodes = [deepest];
      }
    }
    if (nodes.length !== 1)
      throw new Error(
        nodes.length ? "EDITS_CONTROL_AMBIGUOUS" : "EDITS_CONTROL_NOT_FOUND",
      );
    return nodes[0];
  }
  private async press(
    selector: AXSelector,
    intent = "editor-control",
    action?: string,
  ) {
    const node = this.pick(await this.tree(), selector);
    if (forbidden.test([node.title, node.description, node.help].join(" ")))
      throw new Error("AX_ACTION_FORBIDDEN");
    return this.action("press", {
      target: node.target,
      intent,
      action,
      allowCoordinateFallback: true,
      dryRun: false,
    });
  }
  private async value(
    node: AXNode,
    value: string | number | boolean,
    intent: string,
  ) {
    return this.action("set-value", {
      target: node.target,
      intent,
      value,
      dryRun: false,
    });
  }
  private async key(key: string, context: string) {
    const snapshot = await this.tree();
    const focused = snapshot.nodes.filter((n) => n.focused);
    // Prefer the focused leaf input; unknown focus must never become a blind Return.
    const node = focused.sort(
      (a, b) => b.target.path.length - a.target.path.length,
    )[0];
    if (!node)
      throw new Error("AX_ACTION_FORBIDDEN: focused target not established");
    return this.action("key", {
      target: node.target,
      context,
      key,
      dryRun: false,
    });
  }
  private async wait(
    predicate: (snapshot: AXSnapshot) => boolean,
    timeout = this.options.timeoutMs ?? 5000,
  ) {
    const deadline = Date.now() + timeout;
    do {
      const snapshot = await this.tree();
      if (predicate(snapshot)) return snapshot;
      await delay(this.options.pollMs ?? 150);
    } while (Date.now() < deadline);
    throw new Error(
      "EDITS_VERIFICATION_FAILED: expected UI state not observed; read state before retrying",
    );
  }
  private labels(snapshot: AXSnapshot) {
    return snapshot.nodes
      .map((n) => [n.title, n.description, String(n.value ?? "")].join(" "))
      .join("\n");
  }
  private verified(data: Record<string, unknown>) {
    return { verified: true, dryRun: false, ...data, evidence: this.evidence };
  }
  private async selected(id: string) {
    await this.press({ identifier: id }, "timeline-select");
    return this.wait((s) =>
      s.nodes.some((n) => n.identifier === id && n.selected),
    );
  }
  private async metadata(id?: string) {
    const state = await this.project(await this.tree(), id);
    if (!state)
      throw new Error(
        "EDITS_PROJECT_METADATA_UNAVAILABLE: current UI could not be linked to read-only project data",
      );
    return state;
  }
  private async waitMetadata(
    id: string,
    predicate: (state: EditsProject) => boolean,
  ) {
    const deadline = Date.now() + (this.options.timeoutMs ?? 5000);
    do {
      const state = await this.project(await this.tree(), id);
      if (state && predicate(state)) return state;
      await delay(this.options.pollMs ?? 150);
    } while (Date.now() < deadline);
    throw new Error(
      "EDITS_VERIFICATION_FAILED: persisted project state not observed; partial edit may remain",
    );
  }
  private clip(state: EditsProject, id: string) {
    const clip = state.clips.find((c) => c.id === id);
    if (!clip) throw new Error("EDITS_CLIP_NOT_FOUND");
    return clip;
  }
  private async time(seconds: number) {
    const node = this.pick(await this.tree(), {
      identifier: "editor.timecode",
    });
    // Only the actual exposed secondary action is used, never a guessed URL/key.
    const action = node.actions.find(
      (a) => a.description === "Edit timecode" || a.name === "Edit timecode",
    );
    if (!action) throw new Error("EDITS_TIMECODE_ACTION_UNAVAILABLE");
    await this.press(
      { identifier: "editor.timecode" },
      "editor-control",
      "Edit timecode",
    );
    const current = this.pick(await this.tree(), {
      identifier: "editor.timecode",
    });
    // This UI uses frame suffixes. Require observed fps from display (4K/60 etc).
    const quality = (await this.tree()).nodes.find(
      (n) => n.identifier === "editor.resolution",
    );
    const fps = Number(String(quality?.value ?? "").match(/\/(\d+)\b/)?.[1]);
    if (!fps)
      throw new Error(
        "EDITS_FPS_UNVERIFIED: cannot convert seconds to frame timecode",
      );
    const frame = Math.round(seconds * fps),
      sec = Math.floor(frame / fps);
    const formatted = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}.${String(frame % fps).padStart(2, "0")}`;
    await this.value(current, formatted, "timecode");
    await this.key("return", "timecode");
    return this.wait((s) =>
      s.nodes.some(
        (n) =>
          n.identifier === "editor.timecode" &&
          [n.title, n.description, String(n.value)].some((v) =>
            v.includes(formatted),
          ),
      ),
    );
  }
  private async volume(
    id: string,
    decibels: number,
    expectedKind: "video" | "audio",
  ) {
    const before = await this.metadata();
    const target = this.clip(before, id);
    if (
      expectedKind === "video"
        ? target.kind !== "video"
        : !["music", "audio"].includes(target.kind)
    )
      throw new Error(
        "EDITS_CLIP_KIND_MISMATCH: refusing to change another kind of object",
      );
    if (expectedKind === "video" && decibels > -70 && !target.includeAudio)
      throw new Error(
        "EDITS_SOURCE_AUDIO_DISABLED: volume cannot enable excluded source audio",
      );
    await this.selected(id);
    const snapshot = await this.tree();
    const node = this.pick(snapshot, {
      role: "AXSlider",
      label: "Volume value",
    });
    await this.value(node, decibels, "clip-volume");
    const after = await this.wait((s) =>
      s.nodes.some(
        (n) =>
          matchesAX(n, { role: "AXSlider", label: "Volume value" }) &&
          Math.abs(Number(n.value) - decibels) < 0.01,
      ),
    );
    const gain = decibels <= -70 ? 0 : 10 ** (decibels / 20);
    const project = await this.waitMetadata(before.id, (state) => {
      const actual = state.clips.find((c) => c.id === id);
      return (
        !!actual &&
        actual.kind === target.kind &&
        Math.abs(actual.volume - gain) <= Math.max(0.0001, gain * 0.005) &&
        (decibels <= -70 || !actual.muted)
      );
    });
    return this.verified({
      trackId: id,
      kind: target.kind,
      decibels,
      after,
      project,
    });
  }
  private editable(
    snapshot: AXSnapshot,
    intent: "import-path" | "duration" | "text-content",
  ) {
    const role = intent === "text-content" ? "AXTextArea" : "AXTextField";
    const nodes = snapshot.nodes.filter(
      (n) =>
        n.role === role &&
        n.settable &&
        !/Search tools|Search audio/i.test(axLabel(n)),
    );
    const focused = nodes.filter((n) => n.focused);
    if (focused.length === 1) return focused[0];
    if (nodes.length !== 1)
      throw new Error("EDITS_INPUT_AMBIGUOUS: no unique permitted input");
    return nodes[0];
  }
  private async duration(seconds: number) {
    await this.action("menu", { path: ["Clip", "Duration"], dryRun: false });
    const snapshot = await this.tree(),
      field = this.editable(snapshot, "duration");
    const fps = Number(
      String(
        snapshot.nodes.find((n) => n.identifier === "editor.resolution")
          ?.value ?? "",
      ).match(/\/(\d+)/)?.[1],
    );
    if (!fps) throw new Error("EDITS_FPS_UNVERIFIED");
    const frame = Math.round(seconds * fps),
      sec = Math.floor(frame / fps);
    await this.value(
      field,
      `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}.${String(frame % fps).padStart(2, "0")}`,
      "duration",
    );
    await this.key("tab", "duration-dialog");
    await this.press({ role: "AXButton", label: "Set" }, "duration-confirm");
  }
  private async setText(text: string, id?: string, durationSeconds?: number) {
    const before = await this.metadata();
    if (id) {
      if (this.clip(before, id).kind !== "text")
        throw new Error("EDITS_NOT_TEXT");
      await this.selected(id);
    } else {
      await this.press({ role: "AXButton", label: "Text" });
      const s = await this.tree();
      if (s.nodes.some((n) => axLabel(n) === "Styles"))
        await this.press({ role: "AXButton", label: "Styles" });
      await this.press({ role: "AXButton", label: "None" });
    }
    const field = this.editable(await this.tree(), "text-content");
    await this.value(field, text, "text-content");
    if (durationSeconds !== undefined) await this.duration(durationSeconds);
    const candidates = (state: EditsProject) =>
      state.clips.filter(
        (c) =>
          c.kind === "text" &&
          (id ? c.id === id : !before.clips.some((old) => old.id === c.id)),
      );
    const project = await this.waitMetadata(before.id, (state) => {
      const clips = candidates(state);
      return (
        clips.length === 1 &&
        clips[0].text === text &&
        (durationSeconds === undefined ||
          closeEnough(clips[0].duration, durationSeconds))
      );
    });
    const actual = candidates(project)[0];
    const after = await this.wait((s) =>
      s.nodes.some((n) => n.identifier === actual.id),
    );
    return this.verified({ before, after, project, textObject: actual });
  }
  private importDialogOpen(snapshot: AXSnapshot, file: string) {
    if (snapshot.nodes.some((n) => ["AXSheet", "AXDialog"].includes(n.role)))
      return true;
    const confirm = snapshot.nodes.some(
      (n) => n.role === "AXButton" && ["Import", "Open"].includes(axLabel(n)),
    );
    return (
      confirm &&
      snapshot.nodes.some(
        (n) =>
          n.role === "AXBrowser" ||
          (n.role === "AXTextField" && n.value === file),
      )
    );
  }
  private async importMedia(files: string[]) {
    const project = await this.metadata();
    const imported: unknown[] = [];
    for (const file of files) {
      if (!(await stat(file)).isFile())
        throw new Error("EDITS_IMPORT_NOT_FILE");
      const before = await this.media(project.id);
      if (before.some((m) => m.name === path.basename(file)))
        throw new Error(
          "EDITS_IMPORT_NAME_COLLISION: inspect existing Media source before reuse",
        );
      await this.action("menu", {
        path: ["File", "Import Media"],
        dryRun: false,
      });
      await this.key("go-to-folder", "import-dialog");
      await this.value(
        this.editable(await this.tree(), "import-path"),
        file,
        "import-path",
      );
      await this.key("return", "import-dialog");
      await this.press({ role: "AXButton", label: "Import" }, "import-confirm");
      let after = await this.wait((s) => !this.importDialogOpen(s, file));
      const deadline = Date.now() + (this.options.timeoutMs ?? 30_000);
      let proof: { media: EditsMedia; identity: MediaProof } | undefined;
      do {
        after = await this.tree();
        if (
          !this.importDialogOpen(after, file) &&
          (await this.project(after, project.id))?.id === project.id
        ) {
          const additions = (await this.media(project.id)).filter(
            (m) =>
              !before.some((old) => old.aliasId === m.aliasId) &&
              m.name === path.basename(file),
          );
          const verified = [];
          for (const media of additions) {
            const identity = await this.verifyMedia(media, file);
            if (identity) verified.push({ media, identity });
          }
          if (verified.length === 1) {
            proof = verified[0];
            break;
          }
          if (verified.length > 1)
            throw new Error(
              "EDITS_IMPORT_AMBIGUOUS: several new items match source",
            );
        }
        await delay(this.options.pollMs ?? 150);
      } while (Date.now() < deadline);
      if (!proof)
        throw new Error(
          "EDITS_IMPORT_VERIFICATION_FAILED: new project Media alias/source identity not established; do not repeat Import automatically",
        );
      imported.push({ sourcePath: file, ...proof, after });
    }
    return this.verified({
      imported,
      verification: {
        kind: "persisted-media-import",
        reason:
          "Chooser closed; a new current-project Media alias links to the exact available source",
      },
      mediaPanelVisibility: "not-assessed",
    });
  }
  private async run(name: EditsToolName, a: any): Promise<unknown> {
    switch (name) {
      case "reels_edits_status":
        return {
          ...(await this.status()),
          route: "Dashboard main -> native child",
          permissionAttribution:
            "Actual responsible app requires packaged-runtime verification; no prompts were requested.",
        };
      case "reels_edits_ax_tree":
        return this.native.invoke("tree", a);
      case "reels_edits_ax_find":
        return this.native.invoke("find", a);
      case "reels_edits_ax_press":
        return this.action("press", a);
      case "reels_edits_ax_set_value":
        return this.action("set-value", a);
      case "reels_edits_menu":
        return this.action("menu", { ...a, path: a.path.split(">") });
      case "reels_edits_screenshot":
        return this.native.invoke("screenshot", {});
      case "reels_edits_clip_list": {
        const snapshot = await this.tree(false);
        const metadata = await this.project(snapshot, a.projectId);
        return {
          verified: !snapshot.truncated,
          complete: !snapshot.truncated,
          source: "AX",
          snapshot,
          project: metadata,
          clips: snapshot.nodes
            .filter((n) => projectID.test(n.identifier))
            .map((n) => ({
              id: n.identifier,
              label: axLabel(n),
              selected: n.selected,
              target: n.target,
            })),
          metadataVerified: metadata !== null,
        };
      }
      case "reels_edits_open_project": {
        let s = await this.tree();
        const current = a.projectId ? await this.project(s, a.projectId) : null;
        const idMatches = !a.projectId || current?.id === a.projectId;
        const nameMatches =
          !a.name ||
          s.nodes.some(
            (n) => n.identifier === "editor.title" && n.value === a.name,
          );
        if (
          idMatches &&
          nameMatches &&
          s.nodes.some((n) => n.identifier === "editor.title")
        )
          return this.verified({
            alreadyOpen: true,
            project: current,
            snapshot: s,
          });
        if (a.projectId && current?.id === a.projectId && !nameMatches)
          throw new Error(
            "EDITS_PROJECT_NAME_MISMATCH: the requested ID has another observed name",
          );
        if (s.nodes.some((n) => n.identifier === "editor.title"))
          await this.action("menu", { path: ["File", "Close"], dryRun: false });
        s = await this.tree();
        await this.press(
          a.projectId
            ? { identifier: `home.project.${a.projectId}` }
            : { label: a.name },
          "timeline-select",
        );
        const after = await this.wait((s) =>
          s.nodes.some((n) => n.identifier === "editor.title"),
        );
        const project = await this.project(after, a.projectId);
        if (a.projectId && project?.id !== a.projectId)
          throw new Error(
            "EDITS_VERIFICATION_FAILED: opened project ID not established",
          );
        if (
          a.name &&
          !after.nodes.some(
            (n) => n.identifier === "editor.title" && n.value === a.name,
          )
        )
          throw new Error("EDITS_VERIFICATION_FAILED: project name differs");
        return this.verified({ project, snapshot: after });
      }
      case "reels_edits_import_media":
        return this.importMedia(a.paths);
      case "reels_edits_clip_mute":
        return this.volume(a.clipId, a.muted ? -70 : 0, "video");
      case "reels_edits_audio_volume":
        return this.volume(a.trackId, a.decibels, "audio");
      case "reels_edits_clip_trim": {
        const before = await this.metadata(),
          clip = this.clip(before, a.clipId);
        if (clip.kind !== "video") throw new Error("EDITS_NOT_VIDEO");
        if (
          closeEnough(a.inSeconds, clip.sourceIn) &&
          closeEnough(a.outSeconds, clip.sourceOut)
        )
          return this.verified({ alreadyTrimmed: true, before, after: before });
        if (
          a.inSeconds < clip.sourceIn - 0.0001 ||
          a.outSeconds > clip.sourceOut + 0.0001
        )
          throw new Error(
            "EDITS_RANGE_EXPANSION_REQUIRES_UI: only observed inward trims are automated",
          );
        await this.selected(a.clipId);
        if (!closeEnough(a.inSeconds, clip.sourceIn)) {
          await this.time(clip.start + a.inSeconds - clip.sourceIn);
          await this.press({ identifier: "editor.tool.trimStart" });
        }
        await this.time(clip.start + a.outSeconds - a.inSeconds);
        await this.press({ identifier: "editor.tool.trimEnd" });
        const after = await this.waitMetadata(before.id, (state) =>
            state.clips.some(
              (c) =>
                c.id === a.clipId &&
                closeEnough(c.sourceIn, a.inSeconds) &&
                closeEnough(c.sourceOut, a.outSeconds),
            ),
          ),
          actual = this.clip(after, a.clipId);
        if (
          !closeEnough(actual.sourceIn, a.inSeconds) ||
          !closeEnough(actual.sourceOut, a.outSeconds)
        )
          throw new Error(
            "EDITS_VERIFICATION_FAILED: trim readback differs; partial edit may remain",
          );
        return this.verified({ before, after });
      }
      case "reels_edits_text_add":
        return this.setText(a.text, undefined, a.durationSeconds);
      case "reels_edits_text_set":
        return this.setText(a.text, a.clipId, a.durationSeconds);
      case "reels_edits_audio_search": {
        await this.press({ role: "AXButton", label: "Audio" });
        const before = await this.tree();
        const found = await this.native.invoke("find", {
          selector: { role: "AXTextField", label: "Search audio" },
          depth: 16,
          maxNodes: 4000,
        });
        if (
          found.snapshot?.truncated ||
          !Array.isArray(found.matches) ||
          found.matches.length !== 1
        )
          throw new Error(
            "EDITS_INPUT_AMBIGUOUS: no unique Search audio field",
          );
        const field = found.matches[0] as AXNode;
        const results = (s: AXSnapshot) =>
          s.nodes
            .filter(
              (n) => n.role === "AXButton" && / · \d+:\d+/.test(axLabel(n)),
            )
            .map((n) => ({ resultLabel: axLabel(n), target: n.target }));
        const labels = (s: AXSnapshot) =>
          results(s)
            .map((n) => n.resultLabel)
            .join("\n");
        const empty = (s: AXSnapshot) =>
          s.nodes.some(
            (n) =>
              ["AXStaticText", "AXHeading"].includes(n.role) &&
              ["No results", "No results found", "No audio found"].includes(
                axLabel(n),
              ),
          );
        const busy = (s: AXSnapshot) =>
          s.nodes.some(
            (n) =>
              /searching|loading results/i.test(axLabel(n)) ||
              (n.role === "AXProgressIndicator" && /search/i.test(axLabel(n))),
          );
        const hasList = (s: AXSnapshot) =>
          results(s).length > 0 || s.nodes.some((n) => n.role === "AXList");
        const oldLabels = labels(before),
          sameQuery = field.value === a.query,
          oldEmpty = empty(before);
        let responseTransition = false,
          busySeen = busy(before),
          lastSignature = "",
          stableReads = 0;
        let after = before;
        const observe = (s: AXSnapshot) => {
          busySeen = busySeen || busy(s);
          if (!hasList(s) && !empty(s)) responseTransition = true;
        };
        if (!sameQuery) {
          const changed = await this.value(field, a.query, "audio-search");
          if (changed.after?.nodes) observe(changed.after);
        }
        const deadline = Date.now() + (this.options.timeoutMs ?? 5000);
        do {
          after = await this.tree();
          observe(after);
          const queryMatches = after.nodes.some(
            (n) =>
              n.target.pid === field.target.pid &&
              n.target.root === field.target.root &&
              JSON.stringify(n.target.path) ===
                JSON.stringify(field.target.path) &&
              n.value === a.query,
          );
          const currentLabels = labels(after),
            emptyCue = empty(after),
            loading = busy(after);
          const signature = JSON.stringify([
            queryMatches,
            currentLabels,
            emptyCue,
            loading,
            hasList(after),
          ]);
          stableReads = signature === lastSignature ? stableReads + 1 : 1;
          lastSignature = signature;
          const settled = stableReads >= 2 && queryMatches && !loading;
          const responseObserved =
            currentLabels !== oldLabels || responseTransition || busySeen;
          if (
            settled &&
            ((emptyCue && (!oldEmpty || responseObserved)) ||
              (results(after).length > 0 && responseObserved))
          ) {
            return this.verified({
              query: a.query,
              results: results(after),
              completion: emptyCue ? "visible-empty-state" : "observed-results",
              verification: {
                kind: "query-and-result-state",
                reason: emptyCue
                  ? "Explicit empty-result cue with the applied query"
                  : "Stable result view after an observed response/query state",
              },
              snapshot: after,
            });
          }
          await delay(this.options.pollMs ?? 150);
        } while (Date.now() < deadline);
        return {
          verified: false,
          dryRun: false,
          query: a.query,
          results: results(after),
          completion: "unconfirmed",
          reason:
            "Query value was observed but no completed response/empty-state cue could be established; unchanged results are not assumed fresh",
          snapshot: after,
          evidence: this.evidence,
        };
      }
      case "reels_edits_audio_add": {
        const before = await this.metadata();
        const result = this.pick(await this.tree(), {
          role: "AXButton",
          label: a.resultLabel,
        });
        if (!/ · \d+:\d+/.test(axLabel(result)))
          throw new Error("EDITS_NOT_LIBRARY_RESULT");
        await this.press(
          { role: "AXButton", label: a.resultLabel },
          "library-result",
        );
        await this.time(0);
        await this.press(
          { role: "AXButton", label: "add thin" },
          "library-result",
        );
        const after = await this.waitMetadata(before.id, (state) =>
            state.clips.some(
              (c) => !before.clips.some((old) => old.id === c.id),
            ),
          ),
          added = after.clips.filter(
            (c) => !before.clips.some((old) => old.id === c.id),
          );
        if (
          added.length !== 1 ||
          added[0].kind !== "music" ||
          !added[0].audioAssetId ||
          added[0].start !== 0
        )
          throw new Error(
            "EDITS_VERIFICATION_FAILED: new library music not established",
          );
        const song = added[0];
        // UI label + stored library title/artist jointly prove version selection.
        if (!a.resultLabel.startsWith(`${song.title}, ${song.artist},`))
          throw new Error(
            "EDITS_VERIFICATION_FAILED: library title/artist mismatch",
          );
        return this.verified({
          selectedResult: a.resultLabel,
          added: song,
          before,
          after,
        });
      }
      case "reels_edits_audio_segment": {
        const before = await this.metadata(),
          clip = this.clip(before, a.trackId);
        if (clip.kind !== "music") throw new Error("EDITS_NOT_MUSIC");
        if (closeEnough(a.inSeconds, clip.sourceIn))
          return this.verified({
            alreadyAtSourceIn: true,
            before,
            after: before,
          });
        if (a.inSeconds + clip.duration > clip.sourceDuration)
          throw new Error("EDITS_SOURCE_RANGE");
        await this.selected(a.trackId);
        await this.press({ identifier: "editor.tool.toolMode.trim" });
        const node = this.pick(await this.tree(), { identifier: a.trackId });
        if (!node.frame || node.frame.width < 80)
          throw new Error(
            "EDITS_SLIP_GEOMETRY_UNVERIFIED: zoom in before slipping",
          );
        const deltaX =
          (-(a.inSeconds - clip.sourceIn) * node.frame.width) / clip.duration;
        await this.action("drag", {
          target: node.target,
          deltaX,
          deltaY: 0,
          dryRun: false,
        });
        const after = await this.waitMetadata(before.id, (state) =>
            state.clips.some(
              (c) =>
                c.id === a.trackId && !closeEnough(c.sourceIn, clip.sourceIn),
            ),
          ),
          actual = this.clip(after, a.trackId);
        if (
          !closeEnough(actual.sourceIn, a.inSeconds) ||
          !closeEnough(actual.start, clip.start) ||
          !closeEnough(actual.duration, clip.duration)
        )
          throw new Error(
            "EDITS_VERIFICATION_FAILED: slip source/start/duration differs; partial edit may remain",
          );
        return this.verified({ fallback: "coordinate", before, after });
      }
      case "reels_edits_export":
        return this.export(a.outputPath);
    }
  }
  private async export(output: string) {
    await access(output).then(
      () => {
        throw new Error("EDITS_OUTPUT_EXISTS: choose a new path");
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    const root =
      this.options.exportRoot ??
      path.join(os.homedir(), "Movies/Edits/Exports");
    const files = async () =>
      Promise.all(
        (await readdir(root))
          .filter((n) => n.toLowerCase().endsWith(".mp4"))
          .map(async (name) => ({
            file: path.join(root, name),
            info: await stat(path.join(root, name)),
          })),
      );
    const before = await files(),
      known = new Map(before.map((e) => [e.file, e.info.mtimeMs]));
    await this.press({ identifier: "editor.export" });
    const after = await this.wait(
      (s) =>
        this.labels(s).includes("Your video has been exported successfully"),
      90_000,
    );
    const created = (await files()).filter(
      (e) => e.info.mtimeMs > (known.get(e.file) ?? 0) && e.info.size > 0,
    );
    if (created.length !== 1)
      throw new Error(
        "EDITS_EXPORT_FILE_AMBIGUOUS: do not repeat Export; inspect app outputs",
      );
    await delay(this.options.pollMs ?? 500);
    const stable = await stat(created[0].file);
    if (
      stable.size !== created[0].info.size ||
      stable.mtimeMs !== created[0].info.mtimeMs
    )
      throw new Error("EDITS_EXPORT_NOT_STABLE");
    await copyFile(created[0].file, output, constants.COPYFILE_EXCL);
    const delivered = await stat(output);
    if (delivered.size !== stable.size)
      throw new Error("EDITS_EXPORT_COPY_MISMATCH");
    return this.verified({
      editsExportPath: created[0].file,
      outputPath: output,
      bytes: delivered.size,
      after,
      method: "Edits Export then exclusive file copy; no composition/re-encode",
    });
  }
}
