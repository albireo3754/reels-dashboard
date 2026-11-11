/* 블로그 작업공간 전용 16px 아이콘. 공용 아이콘(CloseIcon 등)은 shared/ui/primitives. */
const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M4.5 2h5L12 4.5V14h-7.5z" />
      <path d="M9.5 2v2.5H12M6.5 8h3.5M6.5 10.5h3.5" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg {...iconProps}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5v3h-3" />
    </svg>
  );
}
