'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, FileText, Film, Image as ImageIcon, X } from 'lucide-react';

export function MediaPreviewDialog({ name, label, onClose, children }: {
  name: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <div className="media-backdrop" role="dialog" aria-modal="true" aria-label={name}>
      <div className="media-top">
        <strong>{label}</strong>
        <button ref={closeButton} onClick={onClose} aria-label="미리보기 닫기"><X /></button>
      </div>
      <div className="media-body">{children}</div>
    </div>
  );
}

export function MediaPlaceholder({ kind, children }: {
  kind: 'image' | 'video' | 'file';
  children: ReactNode;
}) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : FileText;
  return <div className="media-placeholder"><Icon size={28} aria-hidden="true" />{children}</div>;
}

export function OriginalMediaPreview({ id, label, mimeType, onClose }: {
  id: string;
  label: string;
  mimeType: string;
  onClose: () => void;
}) {
  const url = `/api/media/${id}`;
  const image = mimeType.startsWith('image/');
  const video = mimeType.startsWith('video/');
  const kind = image ? 'image' : video ? 'video' : 'file';
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const unavailable = () => setState('unavailable');

  return (
    <MediaPreviewDialog name="자료 미리보기" label={label} onClose={onClose}>
      <div className="media-viewport">
        {state === 'unavailable' ? (
          <MediaPlaceholder kind={kind}>
            <p role="alert">{image ? '이미지를 표시할 수 없어요. 원본 파일을 열어서 확인해주세요.' : '영상을 재생할 수 없어요. 원본 파일을 열어서 확인해주세요.'}</p>
          </MediaPlaceholder>
        ) : image ? (
          <>
            {state === 'loading' && <MediaPlaceholder kind="image"><p role="status">사진을 불러오고 있어요.</p></MediaPlaceholder>}
            <img src={url} alt={label} data-loading={state === 'loading' || undefined} onLoad={() => setState('ready')} onError={unavailable} />
          </>
        ) : video ? (
          <video src={url} aria-label={label} controls playsInline preload="metadata" onError={unavailable}
            onLoadedMetadata={event => { if (!event.currentTarget.videoWidth) unavailable(); }} />
        ) : (
          <MediaPlaceholder kind="file"><p>문서·자료 파일은 저장해서 확인할 수 있어요.</p></MediaPlaceholder>
        )}
      </div>
      <a href={url} target="_blank" rel="noreferrer">원본 파일 열기 <ArrowUpRight size={15} /></a>
    </MediaPreviewDialog>
  );
}
