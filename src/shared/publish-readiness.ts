import { z } from "zod";
import type { ICloudUploadStatus, OutboundFile } from "./icloud-delivery";
import { publicationOn, type Publication } from "./publications";

/**
 * Whether a project can be posted to Instagram from a phone right now.
 *
 * The phone posts from the project's saved iCloud outbound folder, so "ready"
 * means that folder holds the current video, cover and post text (caption,
 * pinned comment, reply) and iCloud has finished uploading all of them. A
 * local copy alone is not ready: the phone cannot open it yet.
 */
export const readinessChannels = ["instagram"] as const;
export const publishReadinessInput = z.strictObject({
  projectId: z.string().min(1).max(160),
  channel: z.enum(readinessChannels).default("instagram"),
});
export type PublishReadinessInput = z.input<typeof publishReadinessInput>;

export const requiredOutboundRoles = ["final", "cover", "document"] as const;
export type OutboundRole = OutboundFile["role"];

export const publishReadinessStates = [
  "published",
  "ready",
  "uploading",
  "upload-failed",
  "changed",
  "incomplete",
  "not-delivered",
] as const;
export type PublishReadinessState = (typeof publishReadinessStates)[number];
export const publishReadinessLabels: Record<PublishReadinessState, string> = {
  published: "게시 완료",
  ready: "게시 준비 완료",
  uploading: "iCloud 업로드 중",
  "upload-failed": "iCloud 업로드 실패",
  changed: "전달 파일 변경됨",
  incomplete: "전달 파일 부족",
  "not-delivered": "iCloud 미전달",
};
const roleLabels: Record<OutboundRole, string> = {
  final: "영상",
  cover: "표지",
  document: "게시글",
};

export interface ReadinessFile {
  name: string;
  role: OutboundRole;
  path: string;
  /** A regular file exists at the outbound path. */
  present: boolean;
  /** Its size equals the size recorded at delivery. */
  sizeMatches: boolean;
  isUploaded?: boolean;
  isUploading?: boolean;
  uploadError?: string | null;
}
export interface PublishReadiness {
  projectId: string;
  channel: (typeof readinessChannels)[number];
  state: PublishReadinessState;
  ready: boolean;
  message: string;
  checkedAt: string;
  directory?: string;
  generation?: number;
  missingRoles: OutboundRole[];
  files: ReadinessFile[];
}

interface ReadinessProject {
  id: string;
  publications?: Publication[];
  outbound?: {
    directory: string;
    generation: number;
    files: OutboundFile[];
  };
}

/**
 * Pure decision from the saved project, what is on disk and iCloud's upload
 * states. Order matters: a posted channel stays "published" even after the
 * outbound folder is later replaced.
 */
export function evaluatePublishReadiness(input: {
  project: ReadinessProject;
  channel?: PublishReadiness["channel"];
  files?: Array<Pick<ReadinessFile, "name" | "present" | "sizeMatches">>;
  upload?: ICloudUploadStatus;
  checkedAt?: string;
}): PublishReadiness {
  const { project } = input;
  const channel = input.channel ?? "instagram";
  const outbound = project.outbound;
  const base = {
    projectId: project.id,
    channel,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    directory: outbound?.directory,
    generation: outbound?.generation,
  };
  const result = (
    state: PublishReadinessState,
    message: string,
    missingRoles: OutboundRole[] = [],
    files: ReadinessFile[] = [],
  ): PublishReadiness => ({
    ...base,
    state,
    ready: state === "ready",
    message,
    missingRoles,
    files,
  });

  if (publicationOn(project, channel)?.status === "published")
    return result("published", "이미 게시한 채널이에요.");
  if (!outbound || outbound.generation === 0 || !outbound.files.length)
    return result(
      "not-delivered",
      "iCloud 전달 폴더에 아직 아무것도 보내지 않았어요.",
    );

  const local = new Map((input.files ?? []).map((f) => [f.name, f]));
  const uploads = new Map(
    (input.upload?.files ?? []).map((f) => [f.path.normalize("NFC"), f]),
  );
  const files: ReadinessFile[] = outbound.files.map((f) => {
    const path = joinPath(outbound.directory, f.name);
    const disk = local.get(f.name);
    const up = uploads.get(path.normalize("NFC"));
    return {
      name: f.name,
      role: f.role,
      path,
      present: disk?.present ?? false,
      sizeMatches: disk?.sizeMatches ?? false,
      ...(up && {
        isUploaded: up.isUploaded,
        isUploading: up.isUploading,
        uploadError: up.uploadErrorDescription ?? null,
      }),
    };
  });

  const missingRoles = requiredOutboundRoles.filter(
    (role) => !outbound.files.some((f) => f.role === role),
  );
  if (missingRoles.length)
    return result(
      "incomplete",
      `${missingRoles.map((r) => roleLabels[r]).join("·")} 파일을 전달 폴더에 보내야 해요.`,
      missingRoles,
      files,
    );
  const changed = files.filter((f) => !f.present || !f.sizeMatches);
  if (changed.length)
    return result(
      "changed",
      `전달 기록과 다른 파일이 있어요: ${changed.map((f) => f.name).join(", ")}`,
      [],
      files,
    );
  const notUploaded = files.filter((f) => !f.isUploaded || f.isUploading);
  if (input.upload?.state === "completed" && !notUploaded.length)
    return result("ready", "폰에서 바로 올릴 수 있어요.", [], files);
  // Native status reports most real upload errors (quota, account) as pending
  // with an error description, and only "failed" for files outside iCloud.
  // Either is surfaced as a failure; callers keep re-checking because the same
  // error can be transient while iCloud reconnects.
  const errors = [...new Set(files.flatMap((f) => (f.uploadError ? [f.uploadError] : [])))];
  if (input.upload?.state === "failed" || errors.length)
    return result(
      "upload-failed",
      errors.length
        ? `iCloud 업로드 오류: ${errors.join(" / ")}`
        : "iCloud 업로드 상태를 확인해주세요.",
      [],
      files,
    );
  return result(
    "uploading",
    `iCloud에 올라가는 중이에요 (${files.length - notUploaded.length}/${files.length}).`,
    [],
    files,
  );
}

function joinPath(directory: string, name: string) {
  return directory.endsWith("/") ? directory + name : `${directory}/${name}`;
}
