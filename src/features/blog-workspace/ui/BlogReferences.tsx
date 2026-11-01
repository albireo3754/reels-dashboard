import { useEffect, useState } from "react";
import type { BlogBridge, BlogResult } from "../../../shared/blog";
import {
  blockKind,
  blockLink,
  parseReferences,
  type ReferenceDocument,
} from "../model/references";
import { BlogExtract } from "./BlogExtract";
export function BlogReferences({ api }: { api?: BlogBridge }) {
  const [results, setResults] = useState<BlogResult[]>([]),
    [active, setActive] = useState(""),
    [preview, setPreview] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!api) return;
    const refresh = () =>
      api
        .results()
        .then(setResults)
        .catch((e) => setError(String(e)));
    void refresh();
    // MCP or another view can link/unlink folders while this tab is open.
    return api.onResultsChanged?.(() => void refresh());
  }, [api]);
  const openResult = async (result: BlogResult) => {
    if (!api) return;
    setLoading(true);
    setPreview("");
    try {
      load(await api.readResult(result.id));
      setActive(result.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const [references, setReferences] = useState<ReferenceDocument[]>([]),
    [author, setAuthor] = useState(0),
    [selected, setSelected] = useState(0),
    [frame, setFrame] = useState(""),
    [showOriginal, setShowOriginal] = useState(false),
    [error, setError] = useState("");
  const r = references[author],
    b = r?.blocks[selected];
  const link = r && b ? blockLink(r, b) : null;
  const load = (text: string) => {
    try {
      const parsed = parseReferences(text);
      setReferences(parsed);
      setAuthor(0);
      setSelected(0);
      setFrame(parsed[0].pageUrl);
      setError("");
    } catch (e) {
      setError(`구조 파일을 읽지 못했어요. ${String(e)}`);
    }
  };
  const choose = (i: number) => {
    setSelected(i);
    const next = blockLink(r, r.blocks[i]);
    if (next) setFrame(next);
  };
  return (
    <section className="blog-references" aria-label="블로그 레퍼런스">
      <BlogExtract
        api={api}
        onDone={async (done) => {
          try {
            const list = await api!.results();
            setResults(list);
            const created = list.find((x) => x.id === done.resultId);
            if (created) await openResult(created);
          } catch (e) {
            setError(String(e));
          }
        }}
      />
      <h3>저장된 블로그 분석 결과</h3>
      <p>
        연결한 결과를 선택하면 구조를 볼 수 있어요. 템플릿 미리보기가 있는
        결과는 이 화면에서 바로 열 수 있어요.
      </p>
      <button
        disabled={loading}
        onClick={async () => {
          try {
            const result = await api?.addResult();
            if (result) {
              setResults(await api!.results());
              await openResult(result);
            }
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        분석 결과 폴더 연결
      </button>
      <button
        disabled={loading}
        onClick={async () => {
          try {
            setResults(await api!.results());
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        결과 목록 새로고침
      </button>
      <div className="blog-saved-results">
        {results.map((result) => (
          <article key={result.id}>
            <button
              disabled={loading || !!result.error}
              aria-pressed={active === result.id}
              onClick={() => void openResult(result)}
            >
              {result.names.join(" · ")} · {result.blocks}개 블록
            </button>
            <small>{result.directory}</small>
            {result.error && (
              <p role="alert">
                파일을 읽지 못했어요. 폴더를 옮겼다면 연결을 해제하고 새 위치를
                다시 연결해주세요. {result.error}
              </p>
            )}
            <button
              disabled={loading}
              onClick={async () => {
                try {
                  await api!.removeResult(result.id);
                  if (active === result.id) {
                    setActive("");
                    setPreview("");
                  }
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              연결 해제
            </button>
            {result.preview && (
              <button
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    setPreview(await api!.previewResult(result.id));
                    setActive(result.id);
                    setError("");
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                템플릿 미리보기 열기
              </button>
            )}
          </article>
        ))}
      </div>
      {!results.length && (
        <p>
          아직 연결한 결과가 없어요. 기존 추출 결과 폴더를 한 번 연결하면 앱을
          다시 켜도 목록에 남아요.
        </p>
      )}
      {preview && (
        <section>
          <button onClick={() => setPreview("")}>미리보기 닫기</button>
          <iframe
            className="blog-result-preview"
            title="저장된 블로그 템플릿 미리보기"
            src={preview}
            sandbox="allow-scripts allow-same-origin allow-downloads"
            referrerPolicy="no-referrer"
          />
        </section>
      )}
      <details>
        <summary>구조 파일 직접 가져오기</summary>
        <h3>원본 레퍼런스 구조 탐색</h3>
        <p>
          blog-reference-extract 스킬로 추출한 Markdown 또는 JSON을 열어 원본과
          블록 구조를 비교해요. 원고 배치는 바뀌지 않아요.
        </p>
        <label>
          레퍼런스 구조 파일{" "}
          <input
            type="file"
            accept=".md,.json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 10 * 1024 * 1024) {
                setError("10MB 이하의 파일을 선택해주세요.");
                return;
              }
              load(await file.text());
              e.target.value = "";
            }}
          />
        </label>
        <details>
          <summary>추출을 요청하는 방법</summary>
          <p>
            위의 “네이버 블로그 URL로 추출”을 쓰거나, 에이전트에게 Dashboard MCP
            도구 reels_extract_blog_reference로 URL을 넘기면 같은 기능이
            실행돼요. 이 항목은 이미 가진 reference-structures.md/JSON 파일을
            직접 열 때만 써요.
          </p>
        </details>
        <p className="blog-source">
          직접 가져온 파일은 이 창에서만 유지돼요. 계속 볼 자료는 위에서 결과
          폴더로 연결해주세요.
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      {!preview && r && b && (
        <>
          <div className="blog-reference-toolbar">
            {references.map((x, i) => (
              <button
                key={i}
                aria-pressed={i === author}
                onClick={() => {
                  setAuthor(i);
                  setSelected(0);
                  setFrame(x.pageUrl);
                }}
              >
                {x.name}
              </button>
            ))}
            <button onClick={() => setShowOriginal(!showOriginal)}>
              {showOriginal ? "구조 도식 보기" : "원본 페이지 보기"}
            </button>
            <a href={r.url} target="_blank" rel="noopener noreferrer">
              원본 새 창
            </a>
          </div>
          <div className="blog-reference-grid">
            <div className="blog-reference-list" aria-label="원본 블록 목록">
              {r.blocks.map((x, i) => (
                <button
                  key={i}
                  aria-pressed={selected === i}
                  onClick={() => choose(i)}
                >
                  #{i + 1} {blockKind(x)}
                  <small>
                    문단 {x.paragraphs.length} · 사진 {x.images.length}
                  </small>
                </button>
              ))}
            </div>
            <div className="blog-reference-canvas">
              {showOriginal ? (
                <>
                  <p>원본 사이트가 삽입을 제한하면 새 창으로 확인해주세요.</p>
                  <iframe
                    title="레퍼런스 원본"
                    src={frame}
                    sandbox="allow-scripts allow-same-origin"
                    referrerPolicy="no-referrer"
                  />
                </>
              ) : (
                <>
                  <h4>
                    #{selected + 1} {blockKind(b)}
                  </h4>
                  {b.images.map((im, i) => (
                    <div
                      className="blog-reference-image"
                      key={i}
                      style={{
                        aspectRatio:
                          im.rect.height > 0
                            ? im.rect.width / im.rect.height
                            : 1,
                      }}
                    >
                      사진 {i + 1} · {Math.round(im.rect.width)}×
                      {Math.round(im.rect.height)}
                    </div>
                  ))}
                  {b.paragraphs.map((p, i) => (
                    <div className="blog-reference-paragraph" key={i}>
                      <small>
                        문단 {i + 1} · {p.characters}자
                      </small>
                      <div>
                        {p.runs.map((v, j) =>
                          v.text !== undefined ? (
                            <span
                              className="blog-reference-run-text"
                              title={`${v.characters}자 · ${v.css["font-weight"]} · ${v.css.color}`}
                              key={j}
                              style={runTextStyle(v.css)}
                            >
                              {v.text}
                            </span>
                          ) : (
                            <span
                              className="blog-reference-run"
                              title={`${v.characters}자 · ${v.css["font-weight"]} · ${v.css.color}`}
                              key={j}
                              style={{
                                width: `${Math.min(v.characters, 45) * 0.45}em`,
                                borderBottomWidth:
                                  v.css["font-weight"] === "700" ? 4 : 2,
                                borderColor:
                                  /^(#[\da-f]+|rgba?\([\d., ]+\))$/i.test(
                                    v.css.color,
                                  )
                                    ? v.css.color
                                    : undefined,
                                backgroundColor:
                                  /^(#[\da-f]+|rgba?\([\d., ]+\))$/i.test(
                                    v.css["background-color"],
                                  )
                                    ? v.css["background-color"]
                                    : undefined,
                              }}
                            />
                          ),
                        )}
                      </div>
                    </div>
                  ))}
                  {!b.images.length && !b.paragraphs.length && (
                    <p>
                      {blockKind(b)} · 높이 {Math.round(b.rect.height)}px
                    </p>
                  )}
                </>
              )}
            </div>
            <aside className="blog-reference-inspector">
              <h4>
                #{selected + 1} {blockKind(b)}
              </h4>
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer">
                  원본 블록 열기
                </a>
              ) : (
                <p role="status">
                  이 블록에는 이동 앵커가 없어 원본 위치를 유지해요.
                </p>
              )}
              <pre>{JSON.stringify(b, null, 2)}</pre>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}

const safeColor = (v?: string) =>
  v && /^(#[\da-f]+|rgba?\([\d., ]+\))$/i.test(v) ? v : undefined;
/** Renders an extracted run with its own measured formatting; values are validated, never raw CSS. */
function runTextStyle(css: Record<string, string>) {
  return {
    color: safeColor(css.color),
    backgroundColor: safeColor(css["background-color"]),
    fontWeight: /^\d{3}$/.test(css["font-weight"] ?? "")
      ? Number(css["font-weight"])
      : undefined,
    fontStyle: css["font-style"] === "italic" ? "italic" : undefined,
    fontSize: /^\d{1,2}(\.\d+)?px$/.test(css["font-size"] ?? "")
      ? css["font-size"]
      : undefined,
    fontFamily: /^[\w\s,'"가-힣-]{1,200}$/.test(css["font-family"] ?? "")
      ? css["font-family"]
      : undefined,
    textDecoration: /^(underline|line-through)\b/.test(
      css["text-decoration"] ?? "",
    )
      ? css["text-decoration"].split(" ")[0]
      : undefined,
  } as const;
}
