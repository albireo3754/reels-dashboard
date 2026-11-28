import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { Project } from "../shared/contracts";
import { canShareInstagramFromEdits, isEditsCaption, type EditsShareBlock, type EditsShareResult } from "../shared/edits-final-share";
import type { EditsNativePort } from "../shared/edits";
import { sha256Hex } from "../shared/lib/hash";
import { readJsonFile } from "../shared/lib/fs";
import type { EditsShareSession } from "./edits-share-session";

// @ts-expect-error The publishing-copy SDK is a JavaScript module.
import { parsePublishingCopy } from "../../packages/icloud-object-sdk/publishing-copy.mjs";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const permalink = z.string().regex(/^https:\/\/www\.instagram\.com\/(?:p|reel)\/[\w-]+\/$/);
const nativePreview = z.object({
  fingerprint: digest,
  windowKey: digest,
  image: z.string().max(9_000_000).regex(/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/),
  account: z.string().min(1).max(300),
  caption: z.string().max(1_048_576),
});
const confirmedReceipt = z.object({ state: z.literal("confirmed"), url: permalink });
const outcome = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  confirmedReceipt,
]);
const receipt = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), windowKey: digest }),
  confirmedReceipt,
]);
type Receipt = z.infer<typeof receipt>;
type Approval = Pick<z.infer<typeof nativePreview>, "fingerprint" | "windowKey"> & {
  projectId: string; projectStamp: string; revision: number; until: number; token: string;
};
const noDispatch = {
  FINAL_SHARE_CAPTION: "caption",
  FINAL_SHARE_LOCKED: "locked",
  FINAL_SHARE_SESSION_UNKNOWN: "session-unknown",
  FINAL_SHARE_PERMISSION: "permission",
  FINAL_SHARE_WINDOW: "window",
  FINAL_SHARE_CHANGED: "changed",
} as const;

function blocked(reason: EditsShareBlock): EditsShareResult { return { state: "blocked", reason }; }
function refusal(error: unknown): EditsShareBlock | undefined {
  const code = (error as { code?: string } | null)?.code;
  return code && Object.hasOwn(noDispatch, code) ? noDispatch[code as keyof typeof noDispatch] : undefined;
}

/** The Dashboard main is single-instance for its profile. The on-disk reservations also survive its exit. */
export class EditsFinalShare {
  private inFlight = false;
  private approval?: Approval;
  private active?: { token: string; cancelled: boolean; revoke?: () => void };
  private readonly dir: string;

  constructor(root: string, private readonly native: EditsNativePort,
    private readonly project: (id: string) => Promise<Project | undefined>,
    private readonly session: Pick<EditsShareSession, "watch" | "revision" | "blocked" | "invalidate">) {
    this.dir = path.join(root, "edits-final-share");
  }

  async preview(projectId: string): Promise<EditsShareResult> {
    return this.run(async () => {
      this.approval = undefined;
      const project = await this.project(projectId);
      if (!project || !canShareInstagramFromEdits(project)) return blocked("changed");
      const previous = await this.read(this.projectFile(projectId));
      if (previous) return outcome.parse(previous);
      if (this.session.blocked) return blocked("locked");

      const revision = this.session.revision;
      const lease = this.session.watch();
      try {
        const data = nativePreview.parse(await this.native.invoke("final-share-preview", { lease: lease.file }));
        if (this.session.revision !== revision) return blocked("changed");
        if (await this.read(this.windowFile(data.windowKey))) return blocked("target-used");
        const documentCaption = await this.documentCaption(project);
        if (this.session.revision !== revision) return blocked("changed");
        return this.issuePreview(project, revision, data, documentCaption);
      } finally {
        lease.close();
      }
    });
  }

  private async documentCaption(project: Project): Promise<string | undefined> {
    const documents = new Set((project.resources ?? [])
      .filter(resource => resource.role === "document" && path.isAbsolute(resource.path) && /\.md$/i.test(resource.path))
      .map(resource => resource.path));
    let match: string | undefined;
    for (const file of documents) {
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 256 * 1024) continue;
        const source = await readFile(file, { encoding: "utf8", signal: AbortSignal.timeout(2000) });
        const parsed = parsePublishingCopy(source, project.id, { localCaptionDrafts: true });
        if (!parsed) continue;
        if (match !== undefined) return undefined;
        match = parsed.sections.find((section: { id: string }) => section.id === "caption")?.text ?? "";
      } catch {
        // An unavailable document does not prevent editing the Edits field by hand.
      }
    }
    return match || undefined;
  }

  private issuePreview(project: Project, revision: number, data: z.infer<typeof nativePreview>,
    documentCaption?: string): EditsShareResult {
    const { fingerprint, windowKey, ...preview } = data;
    const token = randomUUID();
    this.approval = { fingerprint, windowKey, projectId: project.id, projectStamp: this.stamp(project),
      revision, until: performance.now() + 90_000, token };
    return { state: "ready", token, ...preview, documentCaption };
  }

  async applyCaption(projectId: string, token: string, caption: unknown): Promise<EditsShareResult> {
    return this.run(async () => {
      const approval = this.approval;
      if (!approval || approval.token !== token || approval.projectId !== projectId) return blocked("changed");
      this.approval = undefined;
      if (!isEditsCaption(caption)) return blocked("caption");
      if (this.session.blocked) return blocked("locked");
      const project = await this.project(projectId);
      if (!project || !canShareInstagramFromEdits(project) || this.stamp(project) !== approval.projectStamp ||
          this.session.revision !== approval.revision) return blocked("changed");
      if (await this.read(this.projectFile(projectId)) || await this.read(this.windowFile(approval.windowKey))) {
        return blocked("target-used");
      }
      const lease = this.session.watch();
      try {
        // Typing can take longer than a Share approval. The helper revalidates the original
        // fingerprint immediately before writing, and returns a new preview after readback.
        const data = nativePreview.parse(await this.native.invoke("final-share-caption", {
          lease: lease.file, fingerprint: approval.fingerprint, expiresAt: Date.now() + 90_000, caption,
        }));
        if (this.session.revision !== approval.revision || data.windowKey !== approval.windowKey) return blocked("changed");
        if (data.caption !== caption) return blocked("caption");
        return this.issuePreview(project, approval.revision, data);
      } finally {
        lease.close();
      }
    });
  }

  cancel(token: string) {
    if (this.approval?.token === token) this.approval = undefined;
    if (this.active?.token === token) {
      this.active.cancelled = true;
      this.active.revoke?.();
    }
  }

  async confirm(projectId: string, token: string): Promise<EditsShareResult> {
    return this.run(async () => {
      const projectFile = this.projectFile(projectId);
      const previous = await this.read(projectFile);
      if (previous) return outcome.parse(previous);
      const approval = this.approval;
      if (!approval || approval.token !== token || approval.projectId !== projectId) return blocked("changed");
      this.approval = undefined;
      const active: NonNullable<EditsFinalShare["active"]> = { token, cancelled: false };
      this.active = active;
      const windowFile = this.windowFile(approval.windowKey);
      try {
        if (this.session.blocked) return blocked("locked");
        const project = await this.project(projectId);
        if (!project || !canShareInstagramFromEdits(project) || this.stamp(project) !== approval.projectStamp ||
            approval.until <= performance.now() || approval.revision !== this.session.revision) return blocked("changed");
        if (await this.read(windowFile)) return blocked("target-used");
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        if (active.cancelled) return blocked("cancelled");
        const lease = this.session.watch();
        active.revoke = lease.close;
        try {
          // Both claims must be on disk before dispatch. A crash or an unclassifiable response leaves them in place.
          const pending = { state: "pending" as const, windowKey: approval.windowKey };
          await this.writeClaim(windowFile, pending);
          await this.writeClaim(projectFile, pending);
          if (active.cancelled || approval.revision !== this.session.revision || approval.until <= performance.now()) {
            await unlink(projectFile);
            await unlink(windowFile);
            return blocked(active.cancelled ? "cancelled" : "changed");
          }

          let response: z.infer<typeof outcome>;
          try {
            response = outcome.parse(await this.native.invoke("final-share-confirm", {
              fingerprint: approval.fingerprint, lease: lease.file,
              expiresAt: Date.now() + (approval.until - performance.now()),
            }));
          } catch (error) {
            const reason = refusal(error);
            if (!reason) return { state: "pending" };
            if (!active.cancelled && (reason === "locked" || reason === "session-unknown")) this.session.invalidate();
            await unlink(projectFile);
            await unlink(windowFile);
            return blocked(active.cancelled ? "cancelled" : reason);
          }
          return response.state === "confirmed" ? await this.recordConfirmation(projectFile, response) : response;
        } finally {
          lease.close();
        }
      } finally {
        this.active = undefined;
      }
    });
  }

  async recheck(projectId: string): Promise<EditsShareResult> {
    return this.run(async () => {
      const projectFile = this.projectFile(projectId);
      const previous = await this.read(projectFile);
      if (!previous) return blocked("changed");
      if (previous.state === "confirmed") return previous;
      if (this.session.blocked) return { state: "pending", reason: "locked" };
      const lease = this.session.watch();
      try {
        const response = outcome.parse(await this.native.invoke("final-share-recheck", {
          windowKey: previous.windowKey, lease: lease.file,
        }));
        return response.state === "confirmed" ? await this.recordConfirmation(projectFile, response) : response;
      } catch (error) {
        const reason = refusal(error);
        if (reason === "locked" || reason === "session-unknown") {
          this.session.invalidate();
          return { state: "pending", reason };
        }
        return { state: "pending" };
      } finally {
        lease.close();
      }
    });
  }

  private async recordConfirmation(file: string, response: z.infer<typeof confirmedReceipt>): Promise<EditsShareResult> {
    const staged = path.join(this.dir, randomUUID());
    try {
      await this.writeClaim(staged, response);
      await rename(staged, file);
      return response;
    } catch {
      await unlink(staged).catch(() => {});
      return { state: "pending" };
    }
  }

  private async run(work: () => Promise<EditsShareResult>): Promise<EditsShareResult> {
    if (this.inFlight) return blocked("busy");
    this.inFlight = true;
    try { return await work(); }
    catch (error) {
      const reason = refusal(error);
      if (reason === "locked" || reason === "session-unknown") this.session.invalidate();
      return blocked(reason ?? "unavailable");
    }
    finally { this.inFlight = false; }
  }

  private projectFile(id: string) { return path.join(this.dir, `project-${sha256Hex(id)}.json`); }
  private windowFile(key: string) { return path.join(this.dir, `window-${key}.json`); }
  private stamp(project: Project) { return sha256Hex(JSON.stringify(project)); }
  private read(file: string) {
    return readJsonFile<Receipt | undefined>(file, receipt.parse, () => undefined);
  }

  private async writeClaim(file: string, value: Receipt) {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
