import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import "./preview-image.css";

type Props = Omit<ComponentPropsWithoutRef<"img">, "src" | "alt"> & {
  src?: string | null;
  alt: string;
  compact?: boolean;
  fallback?: ReactNode;
};

export function PreviewImage(props: Props) {
  return <ImageSource key={props.src} {...props} />;
}

function ImageSource({ src, alt, compact, fallback, onError, className, ...props }: Props) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return fallback ?? (
      <span
        className={["preview-image-placeholder", className].filter(Boolean).join(" ")}
        role={alt ? "img" : undefined}
        aria-label={alt ? `${alt} · 사진을 볼 수 없어요` : undefined}
        aria-hidden={!alt && compact ? true : undefined}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="m4 17 5-4 3 2 4-5 5 5" />
        </svg>
        {!compact && "사진을 볼 수 없어요"}
      </span>
    );
  }
  return <img {...props} className={className} src={src} alt={alt} onError={event => {
    setFailed(true);
    onError?.(event);
  }} />;
}
