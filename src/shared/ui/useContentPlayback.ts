import { useEffect, useState } from "react";
import type {
  ContentMediaBridge,
  OpenedContentMedia,
} from "../content-media";

const errorText = (e: unknown, fallback: string) =>
  e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
    : fallback;

export const playbackCopyStatus =
  "원본을 바로 재생하지 못해 재생용 사본을 준비하고 있어요. 긴 영상은 시간이 걸릴 수 있어요.";
export const openingVideoStatus =
  "영상을 열고 있어요. iCloud에만 있는 영상은 재생용 사본을 준비하느라 시간이 걸릴 수 있어요.";

/**
 * Opens linked content media with the original-first playback policy. Videos start
 * on the original file; when the element reports a load/decode error, call
 * `playbackFailed` once to request a playback copy. A copy that also fails is
 * reported as an error.
 */
export function useContentPlayback(
  bridge: ContentMediaBridge | undefined,
  projectId: string,
  file: string | undefined,
  enabled = true,
) {
  const [media, setMedia] = useState<OpenedContentMedia>();
  const [error, setError] = useState("");
  const [copy, setCopy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setMedia(undefined);
    setError("");
    if (!enabled || !bridge || !file) return;
    let live = true;
    bridge
      .open(projectId, file, copy ? { copy: true } : undefined)
      .then((value) => {
        if (live) setMedia(value);
      })
      .catch((e) => {
        if (live) setError(errorText(e, "자료를 불러오지 못했어요."));
      });
    return () => {
      live = false;
    };
  }, [bridge, projectId, file, enabled, copy, retry]);
  return {
    media,
    error,
    /** True while a requested playback copy is being prepared. */
    preparingCopy: copy && !media && !error,
    playbackFailed(message: string) {
      if (media?.kind === "video" && media.playback === "original" && !copy) {
        setMedia(undefined);
        setCopy(true);
      } else setError(message);
    },
    retry() {
      setRetry((v) => v + 1);
    },
  };
}
