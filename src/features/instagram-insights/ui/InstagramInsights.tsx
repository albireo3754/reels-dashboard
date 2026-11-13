import { useCallback, useEffect, useState } from "react";
import type { Project } from "../../../shared/contracts";
import {
  emptyInstagramState,
  insightMedian,
  insightRates,
  insightValue,
  insightsCohort,
  insightsGroups,
  instagramProject,
  type InstagramInsightsBridge,
  type InstagramInsightsState,
  type InstagramPost,
} from "../../../shared/instagram-insights";
import { errorMessage } from "../../../shared/lib/errors";
import "./instagram-insights.css";

const stamp = (s: string) =>
  new Date(s).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const number = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("ko-KR");
const percent = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);
export function InstagramInsights({
  api,
  projects,
  demo = false,
  onProject,
}: {
  api?: InstagramInsightsBridge;
  projects: Project[];
  demo?: boolean;
  onProject?: (p: Project) => void;
}) {
  const [state, setState] =
    useState<InstagramInsightsState>(emptyInstagramState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [login, setLogin] = useState<"unified" | "instagram">("unified");
  const [expiresAt, setExpiresAt] = useState("");
  const [matureOnly, setMatureOnly] = useState(true);
  const [excludeFrom, setExcludeFrom] = useState("");
  const [excludeTo, setExcludeTo] = useState("");
  const [sort, setSort] = useState("published");
  const [rate, setRate] = useState<"interaction" | "saved" | "shares">(
    "interaction",
  );
  const [topicDrafts, setTopicDrafts] = useState<Record<string, string>>({});
  const load = useCallback(
    async (snapshotId?: string) => {
      if (!api) return;
      setBusy(true);
      setError("");
      try {
        const next = await api.get(snapshotId ? { snapshotId } : {});
        setState(next);
        setError(next.lastError ?? "");
        setUsername(next.connection?.username ?? "");
        setLogin(next.connection?.login ?? "unified");
        const expiry = next.connection?.tokenHealth?.expiresAt;
        setExpiresAt(
          expiry
            ? new Date(
                Date.parse(expiry) -
                  new Date(expiry).getTimezoneOffset() * 60000,
              )
                .toISOString()
                .slice(0, 16)
            : "",
        );
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => api?.onChanged?.(() => void load()), [api, load]);
  const run = async (work: () => Promise<InstagramInsightsState | null>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await work();
      if (next) setState(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const snapshot = state.snapshot;
  const rangeValid =
    (!excludeFrom && !excludeTo) ||
    Boolean(excludeFrom && excludeTo && excludeFrom <= excludeTo);
  const filter = {
    matureOnly,
    excludeFrom: rangeValid ? excludeFrom : "",
    excludeTo: rangeValid ? excludeTo : "",
  };
  const posts = snapshot ? insightsCohort(snapshot, filter) : [];
  const baseline = snapshot
    ? insightsCohort(snapshot, { matureOnly, excludeFrom: "", excludeTo: "" })
    : [];
  const ids = new Set(posts.map((p) => p.id));
  const sorted = [...(snapshot?.media ?? [])].sort((a, b) => {
    const value = (p: InstagramPost) =>
      sort === "published"
        ? Date.parse(p.publishedAt)
        : sort === "saved"
          ? insightRates(p).saved
          : sort === "shares"
            ? insightRates(p).shares
            : insightValue(p, "views");
    return (value(b) ?? -1) - (value(a) ?? -1);
  });
  const missing =
    snapshot?.media.reduce(
      (n, p) => n + p.metrics.filter((m) => m.status !== "available").length,
      0,
    ) ?? 0;
  return (
    <section className="instagram-insights" aria-label="Instagram 인사이트">
      <header className="ig-heading">
        <div>
          <h2>Instagram 인사이트</h2>
          <p>
            조회·도달·저장·공유와 게시 시각을 함께 확인해요.{" "}
            {demo && "합성 데모 데이터예요."}
          </p>
        </div>
        <button
          disabled={!api || !state.connection?.tokenReady || busy || state.busy}
          onClick={() => void run(() => api!.refresh())}
        >
          {busy || state.busy ? "불러오는 중…" : "Instagram에서 가져오기"}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!api && (
        <p>
          인사이트는 데스크톱 앱에만 보관해요. 공유 화면에는 계정 통계를
          포함하지 않아요.
        </p>
      )}
      <details className="ig-connection" open={!state.connection}>
        <summary>
          계정 연결 설정
          {state.connection ? ` · @${state.connection.username}` : ""}
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (api)
              void run(() =>
                api.connect({
                  username,
                  login,
                  ...(expiresAt
                    ? { tokenExpiresAt: new Date(expiresAt).toISOString() }
                    : {}),
                }),
              );
          }}
        >
          <label>
            Instagram 사용자 이름
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your_account"
              required
              maxLength={30}
              disabled={busy}
            />
          </label>
          <label>
            토큰 발급 방식
            <select
              value={login}
              onChange={(e) => setLogin(e.target.value as typeof login)}
              disabled={busy}
            >
              <option value="unified">통합 로그인</option>
              <option value="instagram">Instagram 로그인</option>
            </select>
          </label>
          <label>
            확인된 토큰 만료 시각 (선택)
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={busy}
            />
          </label>
          <button disabled={!api || busy || demo || !username.trim()}>
            조회 토큰 파일 연결
          </button>
        </form>
        <p>
          Meta에서 발급한 조회 토큰 파일을 선택해요. 파일 내용은 앱 화면·공유
          자료에 표시하지 않아요. 토큰을 바꿀 때도 이곳에서 다시 선택해요.
        </p>
      </details>
      {state.connection && !state.connection.tokenReady && (
        <p role="status">
          토큰 파일을 확인하지 못했어요. 실제 토큰과 파일 권한을 확인하고 다시
          연결해주세요.
        </p>
      )}
      {state.connection?.tokenHealth && (
        <p role="status">
          {
            {
              unknown:
                "토큰 만료 시각 미확인 · 60일 또는 만료 없음으로 추정하지 않아요.",
              valid: "확인된 토큰 만료 시각까지 7일 이상 남았어요.",
              expiring: "토큰 만료 임박 · 7일 이내에 다시 연결해주세요.",
              expired:
                "등록된 토큰 만료 시각이 지났어요. 실제 인증 실패 여부는 수집 결과로 확인해요.",
            }[state.connection.tokenHealth.status]
          }
        </p>
      )}
      <div className="ig-source">
        <span>
          {state.connection
            ? `@${state.connection.username}`
            : "연결된 계정 없음"}
        </span>
        <span>
          {snapshot
            ? `${stamp(snapshot.collectedAt)}에 수집 · KST · ${snapshot.source === "scheduled" ? "예약" : "수동"}`
            : "아직 수집한 지표가 없어요"}
        </span>
        {snapshot && (
          <span>
            팔로워 {number(snapshot.account.followersCount)} · 수집{" "}
            {snapshot.media.length} / 조회된 게시물 {snapshot.ownedMediaCount}개
          </span>
        )}
        {!!state.history.length && (
          <label>
            수집 기록
            <select
              aria-label="수집 기록"
              value={snapshot?.id ?? ""}
              disabled={busy}
              onChange={(e) => void load(e.target.value)}
            >
              {state.history.map((h) => (
                <option key={h.id} value={h.id}>
                  {stamp(h.collectedAt)} ·{" "}
                  {h.source === "scheduled" ? "예약" : "수동"} · {h.count}개
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {snapshot && (
        <>
          {snapshot.ownedMediaCount > snapshot.media.length && (
            <p>
              최근 게시물 최대 100개의 지표를 가져왔어요. 계정 전체 게시물과
              수집 범위는 다를 수 있어요.
            </p>
          )}
          {missing > 0 && (
            <p role="status">
              지표 {missing}개가 미제공 또는 조회 오류예요. 빈 값은 0으로
              계산하지 않아요.
            </p>
          )}
          <div className="ig-filters">
            <label>
              <input
                type="checkbox"
                checked={matureOnly}
                onChange={(e) => setMatureOnly(e.target.checked)}
              />
              게시 후 48시간 이상만 비교
            </label>
            <fieldset>
              <legend>제외할 게시 기간 · KST</legend>
              <input
                aria-label="제외 시작일"
                type="date"
                value={excludeFrom}
                onChange={(e) => setExcludeFrom(e.target.value)}
              />
              <span>부터</span>
              <input
                aria-label="제외 종료일"
                type="date"
                value={excludeTo}
                onChange={(e) => setExcludeTo(e.target.value)}
              />
              <button
                onClick={() => {
                  setExcludeFrom("");
                  setExcludeTo("");
                }}
              >
                기간 초기화
              </button>
            </fieldset>
            <label>
              비교 지표
              <select
                value={rate}
                onChange={(e) => setRate(e.target.value as typeof rate)}
              >
                <option value="interaction">반응률</option>
                <option value="saved">저장률</option>
                <option value="shares">공유율</option>
              </select>
            </label>
          </div>
          {!rangeValid && (
            <p role="status">
              시작일과 종료일을 순서대로 선택하면 기간을 제외해요.
            </p>
          )}
          <div className="ig-summary">
            <article>
              <span>비교 릴스</span>
              <strong>{posts.length}개</strong>
              <small>
                기간 제외 전 {baseline.length}개 · 캐러셀은 비교 제외
              </small>
            </article>
            <article>
              <span>반응률 중앙값</span>
              <strong>
                {percent(
                  insightMedian(posts.map((p) => insightRates(p).interaction)),
                )}
              </strong>
              <small>좋아요·댓글·저장·공유 / 도달</small>
            </article>
            <article>
              <span>저장률 중앙값</span>
              <strong>
                {percent(
                  insightMedian(posts.map((p) => insightRates(p).saved)),
                )}
              </strong>
              <small>저장 / 도달</small>
            </article>
            <article>
              <span>공유율 중앙값</span>
              <strong>
                {percent(
                  insightMedian(posts.map((p) => insightRates(p).shares)),
                )}
              </strong>
              <small>공유 / 도달</small>
            </article>
          </div>
          <p className="ig-caveat">
            수집 시점의 누적 지표예요. 게시 후 경과시간·소재·표본 수가 달라 최적
            게시 시각이나 원인으로 단정하지 않아요. 도달은 추산값이며 지표
            반영이 지연될 수 있어요.
          </p>
          <div className="ig-charts">
            {(
              [
                ["weekday", "요일"],
                ["hour", "시간대"],
                ["topic", "주제"],
              ] as const
            ).map(([dimension, title]) => {
              const groups = insightsGroups(
                posts,
                dimension,
                state.topics,
                rate,
              );
              const max = Math.max(1, ...groups.map((g) => g.median ?? 0));
              return (
                <figure
                  key={dimension}
                  aria-label={`${title}별 ${rate === "interaction" ? "반응률" : rate === "saved" ? "저장률" : "공유율"}`}
                >
                  <figcaption>{title}별 중앙값</figcaption>
                  {groups.map((g) => (
                    <div className="ig-bar-row" key={g.label}>
                      <span>{g.label}</span>
                      <div className="ig-bar-track">
                        <i
                          style={{ width: `${((g.median ?? 0) / max) * 100}%` }}
                        />
                      </div>
                      <span>
                        {percent(g.median)}
                        <small>
                          n={g.valid} / {g.count}개
                        </small>
                      </span>
                    </div>
                  ))}
                  {!groups.length && <p>비교할 릴스가 없어요.</p>}
                </figure>
              );
            })}
          </div>
          <header className="ig-table-heading">
            <h3>게시물별 누적 지표 · {sorted.length}개</h3>
            <label>
              정렬
              <select
                aria-label="게시물 정렬"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="published">최근 게시순</option>
                <option value="views">조회순</option>
                <option value="saved">저장률순</option>
                <option value="shares">공유율순</option>
              </select>
            </label>
          </header>
          <div className="ig-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>게시물 · KST</th>
                  <th>주제</th>
                  <th>조회</th>
                  <th>도달</th>
                  <th>저장</th>
                  <th>공유</th>
                  <th>반응률</th>
                  <th>저장률</th>
                  <th>공유율</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((post) => {
                  const project = instagramProject(post, projects);
                  const rates = insightRates(post);
                  return (
                    <tr key={post.id} data-compared={ids.has(post.id)}>
                      <td>
                        {project && onProject ? (
                          <button
                            className="ig-project"
                            onClick={() => onProject(project)}
                          >
                            {project.title}
                          </button>
                        ) : (
                          <strong>
                            {project?.title ||
                              post.captionHead ||
                              "제목 없는 게시물"}
                          </strong>
                        )}
                        <a
                          href={post.permalink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Instagram에서 보기 ↗
                        </a>
                        <small>
                          {stamp(post.publishedAt)} · 게시 후{" "}
                          {(
                            (Date.parse(snapshot.collectedAt) -
                              Date.parse(post.publishedAt)) /
                            3600000
                          ).toFixed(1)}
                          시간{!ids.has(post.id) && " · 비교 제외"}
                        </small>
                      </td>
                      <td>
                        <input
                          aria-label={`${post.id} 주제`}
                          value={
                            topicDrafts[post.id] ?? state.topics[post.id] ?? ""
                          }
                          onChange={(e) =>
                            setTopicDrafts((drafts) => ({
                              ...drafts,
                              [post.id]: e.target.value,
                            }))
                          }
                          placeholder="미분류"
                          maxLength={60}
                          disabled={!api || busy || state.busy}
                          onBlur={(e) => {
                            const topic = e.target.value.trim();
                            if (api && topic !== (state.topics[post.id] ?? ""))
                              void run(async () => {
                                const next = await api.setTopics({
                                  [post.id]: topic,
                                });
                                setTopicDrafts(
                                  ({ [post.id]: _, ...rest }) => rest,
                                );
                                return next;
                              });
                          }}
                        />
                      </td>
                      {["views", "reach", "saved", "shares"].map((k) => (
                        <td key={k}>{number(insightValue(post, k))}</td>
                      ))}
                      <td>{percent(rates.interaction)}</td>
                      <td>{percent(rates.saved)}</td>
                      <td>{percent(rates.shares)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="ig-caveat">
            n은 비율을 계산할 수 있는 게시물 수예요. —는 미제공·오류·도달 0으로
            비율을 계산할 수 없는 값이에요. 주제는 직접 분류하고, 게시물 제목은
            연결된 콘텐츠 기록을 우선 사용해요.
          </p>
        </>
      )}
    </section>
  );
}
