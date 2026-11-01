import { useEffect, useState } from "react";
import type { BlogBridge } from "../../../shared/blog";
import type { BlogExtractProgress, BlogExtractResult } from "../../../shared/blog-restore";

const STAGES: Record<BlogExtractProgress["stage"], string> = {
  open: "원본 열기",
  images: "사진 로딩",
  extract: "구조 추출",
  check: "교차검증",
  write: "저장",
  verify: "복원 대조",
  done: "완료",
  error: "실패",
};

/** URL → in-app extraction. The same service backs MCP `reels_extract_blog_reference`. */
export function BlogExtract({ api, onDone }: { api?: BlogBridge; onDone(result: BlogExtractResult): void }) {
  const [url, setUrl] = useState(""),
    [name, setName] = useState(""),
    [directory, setDirectory] = useState<string | null>(null),
    [running, setRunning] = useState(false),
    [progress, setProgress] = useState<BlogExtractProgress | null>(null),
    [result, setResult] = useState<BlogExtractResult | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!api?.extract) return;
    void api.extractDirectory().then(setDirectory).catch(() => {});
    return api.onExtractProgress((event) => setProgress(event));
  }, [api]);
  if (!api?.extract) return null;
  const run = async () => {
    setRunning(true);
    setError("");
    setResult(null);
    setProgress(null);
    try {
      const done = await api.extract({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      setResult(done);
      onDone(done);
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setRunning(false);
    }
  };
  const f = result?.fidelity;
  return (
    <section className="blog-extract" aria-label="블로그 URL 추출">
      <h3>네이버 블로그 URL로 추출</h3>
      <p>
        글의 블록 순서·중첩 서식·원문·사진 배치를 저장 위치에 보관하고, 결과 목록에 등록한 뒤 복원 화면과 원본 높이를 대조해요. 사진은 파일 없이 원본 주소만 저장해요.
      </p>
      <div className="blog-extract-form">
        <label>
          글 주소
          <input type="url" value={url} placeholder="https://blog.naver.com/아이디/글번호" disabled={running} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          표시 이름
          <input value={name} placeholder="비우면 블로그 아이디" maxLength={100} disabled={running} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="blog-extract-directory">
          <span>저장 위치: {directory ?? "선택 필요"}</span>
          <button
            disabled={running}
            onClick={async () => {
              try {
                const chosen = await api.chooseExtractDirectory();
                if (chosen) setDirectory(chosen);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            저장 위치 선택
          </button>
        </div>
        <button disabled={running || !url.trim() || !directory} onClick={() => void run()}>
          {running ? "추출 중…" : "추출"}
        </button>
      </div>
      {progress && (running || progress.stage === "error") && (
        <p role="status" data-stage={progress.stage}>
          {STAGES[progress.stage]} · {progress.message}
        </p>
      )}
      {error && <p role="alert">추출하지 못했어요. {error}</p>}
      {result && (
        <p role="status" className="blog-extract-result">
          {result.name} · {result.blocks}개 블록 저장 → {result.directory}
          {f && ` · 복원 높이 ±5% ${f.within5pct}/${f.measured}`}
          {result.mobileCrosscheck.ok && (result.mobileCrosscheck.allMatch ? " · 모바일 교차검증 일치" : " · 모바일 교차검증 불일치")}
          {result.warnings.length > 0 && ` · 경고 ${result.warnings.length}개: ${result.warnings.slice(0, 3).join("; ")}`}
        </p>
      )}
    </section>
  );
}
