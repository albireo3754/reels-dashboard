'use client';

import { useEffect, useRef, useState } from 'react';
import type { PreviewStatus } from '../lib/previews';
import { MediaPlaceholder, MediaPreviewDialog } from './media-preview-dialog';

type Props = {
  id: string;
  label: string;
  connected: boolean;
  onClose: () => void;
};
type Screen = PreviewStatus | { status: 'loading' | 'failed' };
const errorMessages = {
  SOURCE_CHANGED: '원본 영상이 바뀌었어요. 다시 시도하면 최신 영상으로 준비해요.',
  SOURCE_UNAVAILABLE: 'Mac에서 원본이나 미리보기를 읽지 못했어요. 영상 위치를 확인하고 다시 시도해주세요.',
  NOT_LOCAL: 'Mac에 영상이 다운로드되면 미리보기를 볼 수 있어요.',
  PREVIEW_FAILED: 'Mac에서 미리보기를 준비하지 못했어요. 다시 시도해주세요.',
  PREVIEW_TIMEOUT: '미리보기 준비 시간이 지났어요. 다시 시도해주세요.',
};

export function VideoPreview({ id, label, connected, onClose }: Props) {
  const api = `/api/previews/${id}`;
  const [screen, setScreen] = useState<Screen>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const sentAttempt = useRef(-1);

  useEffect(() => {
    if (!connected) {
      setPlaybackFailed(false);
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function check(method: 'GET' | 'POST') {
      try {
        const response = await fetch(api, {
          method,
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok || response.redirected) throw new Error('PREVIEW_REQUEST_FAILED');
        const result: PreviewStatus = await response.json();
        if (controller.signal.aborted) return;
        // A network or Mac outage can also fire a media error before the status poll sees it.
        if (result.status === 'offline') setPlaybackFailed(false);
        setScreen(result.status === 'ready' && playbackFailed ? { status: 'failed' } : result);
        const delay = result.status === 'pending' ? 1_200
          : result.status === 'offline' ? 3_000
          : result.status === 'ready' && !playbackFailed ? 8_000 : null;
        if (delay !== null) timer = setTimeout(() => void check('GET'), delay);
      } catch {
        if (!controller.signal.aborted) setScreen({ status: 'failed' });
      }
    }
    const method = sentAttempt.current === attempt ? 'GET' : 'POST';
    sentAttempt.current = attempt;
    void check(method);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, attempt, connected, playbackFailed]);

  function retry() {
    setScreen({ status: 'loading' });
    setPlaybackFailed(false);
    setAttempt(value => value + 1);
  }

  let message: string;
  let canRetry = false;
  if (!connected) {
    message = '인터넷 연결이 끊겼어요. 연결되면 상태를 다시 확인해요.';
  } else {
    switch (screen.status) {
      case 'ready':
        message = playbackFailed ? '미리보기 상태를 확인하는 중이에요.' : '미리보기를 재생할 수 있어요.';
        break;
      case 'offline':
        message = 'Mac이 오프라인이에요. Mac이 연결되면 다시 시도해주세요.';
        canRetry = true;
        break;
      case 'idle':
        message = '미리보기를 다시 준비할 수 있어요.';
        canRetry = true;
        break;
      case 'error':
        message = errorMessages[screen.error];
        canRetry = true;
        break;
      case 'failed':
        message = '미리보기를 재생하지 못했어요. 연결을 확인하고 다시 시도해주세요.';
        canRetry = true;
        break;
      default:
        message = 'Mac에서 영상 미리보기를 준비하고 있어요.';
    }
  }

  const ready = connected && screen.status === 'ready' && !playbackFailed;
  return (
    <MediaPreviewDialog name="영상 미리보기" label={label} onClose={onClose}>
      <div className="media-viewport">
        {ready ? (
          <video src={`${api}/media?v=${encodeURIComponent(screen.version)}`} aria-label={label}
            controls playsInline preload="metadata" onError={event => {
              if (event.currentTarget.isConnected) setPlaybackFailed(true);
            }} />
        ) : (
          <MediaPlaceholder kind="video">
            <p className="video-preview-status" role="status">{message}</p>
            {canRetry && <button className="video-preview-retry" onClick={retry}>다시 시도</button>}
          </MediaPlaceholder>
        )}
      </div>
      {ready && <p className="video-preview-status" role="status">{message}</p>}
    </MediaPreviewDialog>
  );
}
