import {
  readInline,
  restyle,
  cssHex,
  type CanonicalFinding,
  type InlineRun,
} from "../../../shared/canonical-blog";
function sample(source: string, start: number, end: number) {
  let at = 0;
  return readInline(source).flatMap((r) => {
    const lo = Math.max(0, start - at),
      hi = Math.min(r.text.length, end - at);
    at += r.text.length;
    return lo < hi ? [{ ...r, text: r.text.slice(lo, hi) }] : [];
  });
}
function Sample({
  runs,
  typography,
}: {
  runs: InlineRun[];
  typography?: { fontFamily: string; fontSize: number };
}) {
  return (
    <p
      className="ce-format-sample"
      style={{ fontFamily: typography?.fontFamily }}
    >
      {runs.map((r, i) => (
        <span
          key={i}
          style={{
            color: r.style.color ?? "#333333",
            backgroundColor: r.style.background ?? "transparent",
            fontWeight: r.style.weight ?? 400,
            fontSize: r.style.size ?? typography?.fontSize ?? 16,
            whiteSpace: "pre-wrap",
          }}
        >
          {r.text}
        </span>
      ))}
    </p>
  );
}
function colorName(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const hex = cssHex(value) ?? value;
  return (
    (
      {
        "#333333": "기본색",
        "#a64132": "적갈색",
        "#85613f": "갈색",
        "#0096dc": "하늘색",
        "#54b800": "초록",
        "#fff8b2": "노랑",
        "#ffe3c8": "살구",
        "#e2e2e2": "연회색",
      } as Record<string, string>
    )[hex] ?? hex
  );
}
function description(runs: InlineRun[], baseSize = 16) {
  return [
    ...new Set(
      runs.map(
        (r) =>
          `${r.style.size ?? baseSize}px · ${r.style.weight === 700 ? "굵게" : "보통"} · 글자 ${colorName(r.style.color, "기본색")} · 배경 ${colorName(r.style.background, "없음")}`,
      ),
    ),
  ].join(" / ");
}
export function FormatComparison({
  finding,
  source,
  typography,
}: {
  finding: CanonicalFinding;
  source?: string;
  typography?: { fontFamily: string; fontSize: number };
}) {
  const p = finding.proposal;
  if (!p?.entry || source === undefined) return null;
  const phrase = p.entry.phrase,
    plain = readInline(source)
      .map((r) => r.text)
      .join(""),
    start = plain.indexOf(phrase);
  if (start < 0)
    return (
      <p className="ce-warning">현재 본문에서 제안 구절을 찾을 수 없어요.</p>
    );
  const { bg, ...style } = p.entry.style;
  const after = restyle(
    source,
    start,
    start + phrase.length,
    { ...style, ...(bg ? { background: bg } : {}) },
    p.op === "remove",
  );
  const beforeRuns = sample(source, start, start + phrase.length),
    afterRuns = sample(after, start, start + phrase.length);
  return (
    <div className="ce-format-comparison" aria-label="서식 변경 전후">
      <div>
        <small>현재 서식</small>
        <Sample runs={beforeRuns} typography={typography} />
        <span>{description(beforeRuns, typography?.fontSize)}</span>
      </div>
      <div>
        <small>제안 서식</small>
        <Sample runs={afterRuns} typography={typography} />
        <span>{description(afterRuns, typography?.fontSize)}</span>
      </div>
    </div>
  );
}
