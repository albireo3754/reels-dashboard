import { useEffect, useRef, useState } from "react";
import {
  templateContent,
  cardPlanSchema,
  type Card,
  type CardPlan,
  type CardAsset,
  type CardJob,
  type CardNewsBridge,
} from "../../../shared/card-news";
import {
  newCardPlan,
  cardLayouts,
  cardLayout,
  selectCardLayout,
  type CardLayout,
  timeline,
  recommendTiming,
  recommendedSeconds,
  musicError,
  videoError,
} from "../../../shared/card-news-model";
import { drawCard } from "../model/frame";
import "./card-news.css";

function VideoBackground({
  url,
  time,
  playing,
  onError,
}: {
  url: string;
  time: number;
  playing: boolean;
  onError: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || v.readyState < 1) return;
    if (Math.abs(v.currentTime - time) > 0.2) v.currentTime = time;
    if (playing) void v.play().catch(onError);
    else v.pause();
  }, [time, playing, url]);
  return (
    <video
      ref={ref}
      src={url}
      muted
      playsInline
      preload="auto"
      aria-label="영상 배경"
      onLoadedMetadata={() => {
        if (ref.current) {
          ref.current.currentTime = time;
          if (playing) void ref.current.play().catch(onError);
        }
      }}
      onError={onError}
    />
  );
}

export function CardNews({
  api,
  active,
}: {
  api?: CardNewsBridge;
  active: boolean;
}) {
  const [plan, setPlan] = useState<CardPlan>(newCardPlan);
  const [assets, setAssets] = useState<Record<string, CardAsset>>({});
  const [recent, setRecent] = useState<Array<{ id: string; title: string }>>(
    [],
  );
  const [selected, setSelected] = useState(0);
  const [frames, setFrames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [job, setJob] = useState<CardJob | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [align, setAlign] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const lock = useRef(false);
  const segments = timeline(plan.cards);
  const total = segments.at(-1)!.end;
  const music = plan.music.assetId ? assets[plan.music.assetId] : undefined;
  const rendering = job?.state === "running";
  const disabled = busy || rendering;
  const current = playing
    ? Math.max(
        0,
        segments.findIndex((c) => cursor >= c.start && cursor < c.end),
      )
    : selected;
  const invalidMusic = musicError(plan, music?.duration);
  function stop() {
    setPlaying(false);
    audio.current?.pause();
  }
  function change(next: CardPlan) {
    stop();
    setPlan(next);
    setFrames([]);
    setDirty(true);
    setNotice("");
    setError("");
    setCursor(0);
  }
  function editCard(index: number, patch: Partial<Card>) {
    change({
      ...plan,
      cards: plan.cards.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  }
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save() {
    cardPlanSchema.parse(plan);
    if (!api)
      throw new Error(
        "구성 저장과 MP4 출력은 데스크톱 앱에서 사용할 수 있어요.",
      );
    const next = await api.save(plan);
    setPlan(next);
    setDirty(false);
    setRecent(await api.list());
    return next;
  }
  useEffect(() => {
    if (active && api)
      void api
        .list()
        .then(setRecent)
        .catch((e) => setError(String(e)));
  }, [active, api]);
  useEffect(() => {
    if (!active) stop();
  }, [active]);
  useEffect(() => {
    if (!rendering || !job || !api) return;
    let live = true;
    const timer = setInterval(() => {
      void api
        .job(job.id)
        .then((next) => {
          if (live) setJob(next);
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    }, 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [rendering, job?.id, api]);
  useEffect(() => {
    if (!playing) return;
    const start = performance.now() - cursor * 1000;
    let raf = 0;
    const tick = () => {
      const next = (performance.now() - start) / 1000;
      if (next >= total) {
        setCursor(total);
        setSelected(plan.cards.length - 1);
        stop();
        return;
      }
      setCursor(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  async function makeFrames() {
    cardPlanSchema.parse(plan);
    plan.cards.forEach(templateContent);
    if (api) {
      const next = await api.preview(plan);
      setFrames(next);
      return next;
    }
    const next = [];
    for (let i = 0; i < plan.cards.length; i++) {
      const card = plan.cards[i];
      try {
        const media = card.imageId ? assets[card.imageId] : undefined;
        if (media?.kind === "video") {
          const invalid = videoError(card, media.duration);
          if (invalid) throw new Error(invalid);
        }
        next.push(
          await drawCard(
            card,
            plan.style,
            card.imageId ? assets[card.imageId]?.url : undefined,
            media?.kind === "video",
          ),
        );
      } catch (e) {
        throw new Error(
          `${i + 1}번 카드: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    setFrames(next);
    return next;
  }
  async function play() {
    if (invalidMusic) throw new Error(invalidMusic);
    if (!frames.length) await makeFrames();
    setCursor(0);
    setSelected(0);
    if (audio.current && music) {
      audio.current.currentTime = plan.music.offset;
      audio.current.volume = plan.music.volume;
      await audio.current.play();
    }
    setPlaying(true);
  }
  async function choose(kind: "image" | "audio" | "video", index: number) {
    if (!api)
      throw new Error("사진·음악 선택은 데스크톱 앱에서 사용할 수 있어요.");
    const asset = await api.chooseAsset(kind);
    if (!asset) return;
    setAssets((old) => ({ ...old, [asset.id]: asset }));
    if (kind !== "audio")
      editCard(index, { imageId: asset.id, videoStart: 0, overlayId: null });
    else
      change({
        ...plan,
        music: { ...plan.music, assetId: asset.id, offset: 0 },
      });
  }
  function move(index: number, delta: number) {
    const cards = [...plan.cards];
    [cards[index], cards[index + delta]] = [cards[index + delta], cards[index]];
    change({ ...plan, cards });
    setSelected(index + delta);
  }
  return (
    <section className="card-news" aria-label="카드뉴스 제작">
      <div className="panel card-news-toolbar">
        <div>
          <span className="eyebrow">CARD NEWS</span>
          <h2>사진·영상으로 전하는 여행 정보</h2>
          <p className="muted">
            문구·비교표·마무리 중에서 고르고 사진이나 영상만 바꿔주세요.
          </p>
        </div>
        <div className="card-news-actions">
          <button
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                if (dirty) await save();
                stop();
                setPlan(newCardPlan());
                setAssets({});
                setFrames([]);
                setSelected(0);
                setJob(null);
                setCursor(0);
                setDirty(false);
              })
            }
          >
            새 구성
          </button>
          <label>
            저장된 구성
            <select
              aria-label="저장된 구성"
              disabled={disabled || !api}
              value=""
              onChange={(e) => {
                const value = e.target.value;
                if (value)
                  void run(async () => {
                    if (dirty) await save();
                    const loaded = await api!.load(value);
                    stop();
                    setPlan(loaded.plan);
                    setAssets(
                      Object.fromEntries(loaded.assets.map((a) => [a.id, a])),
                    );
                    setFrames([]);
                    setSelected(0);
                    setJob(null);
                    setCursor(0);
                    setDirty(false);
                  });
              }}
            >
              <option value="">구성을 선택하세요</option>
              {recent.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={disabled || !api}
            onClick={() =>
              void run(async () => {
                await save();
                setNotice("구성을 저장했어요.");
              })
            }
          >
            구성 저장{dirty ? " *" : ""}
          </button>
        </div>
      </div>
      {!api && (
        <p className="notice">
          브라우저에서는 문구·시간·미리보기를 연습할 수 있어요. 사진·음악 선택,
          저장, MP4 출력은 데스크톱 앱에서 제공해요.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="card-news-layout">
        <div className="card-news-preview panel">
          <div className="section-heading">
            <h3>재생 미리보기</h3>
            <strong data-testid="card-total">
              {total.toFixed(2)}초 · {plan.cards.length}장
            </strong>
          </div>
          <div className="card-news-screen">
            {frames[current] &&
              assets[plan.cards[current].imageId ?? ""]?.kind === "video" && (
                <VideoBackground
                  key={plan.cards[current].id + plan.cards[current].imageId}
                  url={assets[plan.cards[current].imageId!].url}
                  time={
                    (plan.cards[current].videoStart ?? 0) +
                    (playing
                      ? Math.max(0, cursor - segments[current].start)
                      : 0)
                  }
                  playing={playing}
                  onError={() => {
                    stop();
                    setError("영상 배경을 재생할 수 없어요.");
                  }}
                />
              )}
            {frames[current] ? (
              <img
                src={frames[current]}
                alt={`${current + 1}번 카드 미리보기`}
              />
            ) : (
              <p>
                사진과 문구를 넣고
                <br />
                미리보기를 만들어주세요.
              </p>
            )}
          </div>
          <p data-testid="card-preview-position">
            {current + 1}번 카드 ·{" "}
            {playing ? cursor.toFixed(1) : segments[selected]?.start.toFixed(1)}
            초
          </p>
          <div className="card-news-actions">
            <button
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  stop();
                  await makeFrames();
                })
              }
            >
              카드 미리보기 만들기
            </button>
            <button
              disabled={disabled}
              onClick={() => (playing ? stop() : void run(play))}
            >
              {playing ? "재생 멈춤" : "처음부터 재생"}
            </button>
          </div>
          <div className="card-news-timeline" aria-label="카드 타임라인">
            {segments.map((c, i) => (
              <button
                key={c.id}
                aria-label={`${i + 1}번 카드 보기`}
                aria-pressed={selected === i}
                disabled={disabled}
                style={{ flexGrow: c.frames }}
                onClick={() => {
                  stop();
                  setSelected(i);
                  setCursor(c.start);
                }}
              >
                {i + 1}
                <small>{(c.frames / 30).toFixed(1)}초</small>
              </button>
            ))}
          </div>
          <p className="muted">
            사진은 중앙 기준으로 세로 화면에 맞춰요. 전환은 하드 컷이며 글자는
            카드 시작과 함께 표시해요.
          </p>
          <button
            className="primary"
            disabled={disabled || !api}
            onClick={() =>
              void run(async () => {
                stop();
                if (
                  plan.cards.some(
                    (c) =>
                      !c.imageId ||
                      (!c.imageOnly && !c.overlayId && !c.text.trim()),
                  )
                )
                  throw new Error(
                    "모든 카드에 사진 또는 영상과 문구를 넣어주세요.",
                  );
                if (invalidMusic) throw new Error(invalidMusic);
                const images = frames.length ? frames : await makeFrames();
                const saved = await save();
                const result = await api!.export(saved, images);
                if (result) setJob(result);
              })
            }
          >
            MP4 내보내기
          </button>
          <p className="muted compact">
            1080 × 1920 · 30fps · H.264{music ? " + AAC 음악" : " · 무음"}
          </p>
          {job && (
            <div role="status" className="card-news-job">
              {job.state === "running" ? (
                <>
                  <p>내보내는 중 · {job.progress}%</p>
                  <progress max={100} value={job.progress} />
                  <button
                    onClick={() =>
                      void run(async () => {
                        await api!.cancel(job.id);
                        setJob(await api!.job(job.id));
                      })
                    }
                  >
                    내보내기 취소
                  </button>
                </>
              ) : job.state === "completed" ? (
                <>
                  <h3>MP4 내보내기 완료</h3>
                  <p>{job.outputPath}</p>
                  {job.error && <p>{job.error}</p>}
                  <button onClick={() => void run(() => api!.reveal(job.id))}>
                    결과 폴더 열기
                  </button>
                </>
              ) : (
                <p>
                  {job.state === "cancelled"
                    ? "내보내기를 취소했어요."
                    : job.error}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="card-news-controls">
          <fieldset className="panel" disabled={disabled}>
            <label>
              구성 제목
              <input
                value={plan.title}
                maxLength={120}
                onChange={(e) => change({ ...plan, title: e.target.value })}
              />
            </label>
            <div className="card-news-grid">
              <label>
                배경 어둡기 (%)
                <input
                  type="number"
                  min={0}
                  max={80}
                  value={Math.round(plan.style.darkness * 100)}
                  onChange={(e) =>
                    change({
                      ...plan,
                      style: {
                        ...plan.style,
                        darkness: Number(e.target.value) / 100,
                      },
                    })
                  }
                />
              </label>
            </div>
            <div className="card-news-actions">
              <button
                onClick={() =>
                  void run(async () => change(recommendTiming(plan, align)))
                }
              >
                읽는 시간 추천 적용
              </button>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={align}
                  onChange={(e) => setAlign(e.target.checked)}
                />
                읽는 시간을 지키며 박자에 맞추기
              </label>
            </div>
            <p className="muted">
              6장 기본값은 3 / 3.5 / 3.5 / 6 / 5 / 3초예요. 추천은 역할과 글자
              수를 고려한 시작값이며 직접 조정할 수 있어요. 박자 맞춤은 입력한
              BPM 기준이에요.
            </p>
          </fieldset>
          {plan.cards.map((card, i) => (
            <fieldset
              className={`panel card-news-card ${selected === i ? "selected" : ""}`}
              key={card.id}
              disabled={disabled}
            >
              <div className="section-heading">
                <h3>
                  {i + 1}번 · {cardLayouts[cardLayout(card)]}
                </h3>
                <span>
                  {segments[i].start.toFixed(2)}–{segments[i].end.toFixed(2)}초
                </span>
              </div>
              <div className="card-news-grid">
                <label>
                  {i + 1}번 노출 시간
                  <input
                    type="number"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={card.seconds}
                    onChange={(e) =>
                      editCard(i, { seconds: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <label>
                {i + 1}번 카드 종류
                <select
                  aria-label={`${i + 1}번 카드 종류`}
                  value={cardLayout(card)}
                  onChange={(e) =>
                    editCard(
                      i,
                      selectCardLayout(
                        card,
                        e.target.value as CardLayout,
                        i === 0,
                      ),
                    )
                  }
                >
                  {Object.entries(cardLayouts).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {cardLayout(card) === "text" && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    aria-label={`${i + 1}번 크게 강조`}
                    checked={card.templateId === "summary"}
                    onChange={(e) =>
                      editCard(i, {
                        ...selectCardLayout(card, "text", i === 0),
                        templateId: e.target.checked
                          ? "summary"
                          : i === 0
                            ? "hook"
                            : "body",
                      })
                    }
                  />
                  크게 강조
                </label>
              )}
              <p className="muted">
                글자 크기·굵기·행간·자간·위치는 템플릿으로 고정돼요. 문구와
                줄바꿈만 바꿔주세요.
              </p>
              {(card.imageOnly || card.overlayId) && (
                <p role="alert">
                  기존 커스텀 카드예요. 위에서 템플릿을 선택하면 문구로 다시
                  만들어요.
                </p>
              )}
              {card.templateId === "comparison" && (
                <>
                  <label>
                    {i + 1}번 표 머리글
                    <input
                      value={card.table?.columns.join(" | ") ?? ""}
                      onChange={(e) => {
                        const cols = e.target.value
                          .split("|")
                          .map((x) => x.trim());
                        editCard(i, {
                          table: {
                            columns: [
                              cols[0] ?? "",
                              cols[1] ?? "",
                              cols[2] ?? "",
                            ],
                            rows: card.table?.rows ?? [["", "", ""]],
                          },
                        });
                      }}
                    />
                  </label>
                  <label>
                    {i + 1}번 표 행 (항목 | 이전 | 이후)
                    <textarea
                      rows={6}
                      value={
                        card.table?.rows.map((r) => r.join(" | ")).join("\n") ??
                        ""
                      }
                      onChange={(e) => {
                        const rows = e.target.value.split("\n").map((line) => {
                          const c = line.split("|").map((x) => x.trim());
                          return [c[0] ?? "", c[1] ?? "", c[2] ?? ""] as [
                            string,
                            string,
                            string,
                          ];
                        });
                        editCard(i, {
                          table: {
                            columns: card.table?.columns ?? [
                              "항목",
                              "이전",
                              "이후",
                            ],
                            rows,
                          },
                        });
                      }}
                    />
                  </label>
                </>
              )}
              {card.templateId === "follow" && (
                <label>
                  {i + 1}번 서명
                  <input
                    value={card.signature ?? ""}
                    onChange={(e) => editCard(i, { signature: e.target.value })}
                  />
                </label>
              )}
              <label>
                {i + 1}번 보조 설명
                <textarea
                  rows={2}
                  value={card.notes ?? ""}
                  onChange={(e) => editCard(i, { notes: e.target.value })}
                />
              </label>
              <label>
                {i + 1}번 문구{card.imageOnly ? " (기록용)" : ""}
                <textarea
                  aria-label={`${i + 1}번 문구`}
                  rows={3}
                  maxLength={600}
                  value={card.text}
                  onChange={(e) => editCard(i, { text: e.target.value })}
                  placeholder="자연스럽게 읽히는 문장을 입력해주세요."
                />
              </label>
              {card.seconds < recommendedSeconds(card) && (
                <p className="card-news-hint">
                  추천 {recommendedSeconds(card)}초보다 짧아요. 읽는 속도를
                  미리보기로 확인해주세요.
                </p>
              )}
              <div className="card-news-actions">
                <button
                  disabled={!api}
                  onClick={() => void run(() => choose("image", i))}
                >
                  {i + 1}번 사진 선택
                </button>
                <button
                  disabled={!api}
                  onClick={() => void run(() => choose("video", i))}
                >
                  {i + 1}번 영상 선택
                </button>
                <span>
                  {card.imageId
                    ? (assets[card.imageId]?.name ?? "사진 불러오기 필요")
                    : "사진 미선택"}
                </span>
              </div>
              {assets[card.imageId ?? ""]?.kind === "video" && (
                <>
                  <label>
                    {i + 1}번 영상 시작 (초)
                    <input
                      type="number"
                      min={0}
                      max={assets[card.imageId!].duration}
                      step={0.1}
                      value={card.videoStart ?? 0}
                      onChange={(e) =>
                        editCard(i, { videoStart: Number(e.target.value) })
                      }
                    />
                  </label>
                  <p className="muted">
                    원본 {assets[card.imageId!].duration?.toFixed(2)}초 · 선택
                    구간만 재생하며 원본 소리는 사용하지 않아요.
                  </p>
                </>
              )}
              <div className="card-news-actions">
                <button
                  aria-label={`${i + 1}번 위로`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`${i + 1}번 아래로`}
                  disabled={i === plan.cards.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  disabled={plan.cards.length === 1}
                  onClick={() => {
                    change({
                      ...plan,
                      cards: plan.cards.filter((_, n) => n !== i),
                    });
                    setSelected(0);
                  }}
                >
                  {i + 1}번 카드 삭제
                </button>
              </div>
            </fieldset>
          ))}
          <button
            disabled={disabled || plan.cards.length >= 20}
            onClick={() =>
              change({
                ...plan,
                cards: [
                  ...plan.cards,
                  {
                    id: crypto.randomUUID(),
                    role: "explanation",
                    templateId: "body",
                    text: "",
                    seconds: 3.5,
                    imageId: null,
                  },
                ],
              })
            }
          >
            카드 추가
          </button>
          <fieldset className="panel" disabled={disabled}>
            <h3>음악과 리듬</h3>
            <p>
              글을 읽기 편한 일정한 리듬, 가사가 적은 구간부터 비교해보세요.
              100~120 BPM은 이번 편집의 시작 제안이며 바이럴 보장 기준은
              아니에요.
            </p>
            <div className="card-news-actions">
              <button
                disabled={!api}
                onClick={() => void run(() => choose("audio", 0))}
              >
                음악 파일 선택
              </button>
              {music && (
                <button
                  onClick={() =>
                    change({
                      ...plan,
                      music: { ...plan.music, assetId: null, offset: 0 },
                    })
                  }
                >
                  음악 해제
                </button>
              )}
            </div>
            <p>
              {music
                ? `${music.name} · ${music.duration?.toFixed(1)}초`
                : "음악 미선택 · 무음으로 내보내요."}
            </p>
            <div className="card-news-grid">
              <label>
                음악 시작 (초)
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={plan.music.offset}
                  onChange={(e) =>
                    change({
                      ...plan,
                      music: { ...plan.music, offset: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label>
                음악 볼륨 (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(plan.music.volume * 100)}
                  onChange={(e) =>
                    change({
                      ...plan,
                      music: {
                        ...plan.music,
                        volume: Number(e.target.value) / 100,
                      },
                    })
                  }
                />
              </label>
              <label>
                박자 BPM
                <input
                  type="number"
                  min={40}
                  max={240}
                  value={plan.music.bpm}
                  onChange={(e) =>
                    change({
                      ...plan,
                      music: { ...plan.music, bpm: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={plan.music.loop}
                  onChange={(e) =>
                    change({
                      ...plan,
                      music: { ...plan.music, loop: e.target.checked },
                    })
                  }
                />
                짧은 음악 반복
              </label>
            </div>
            {invalidMusic && <p role="alert">{invalidMusic}</p>}
            {music && (
              <audio
                ref={audio}
                src={music.url}
                loop={plan.music.loop}
                preload="metadata"
                onError={() => {
                  stop();
                  setError(
                    "이 음악은 미리보기에서 재생할 수 없어요. 다른 파일을 선택해주세요.",
                  );
                }}
              />
            )}
            <p className="muted">
              직접 준비한 음악 파일을 사용해요. BPM은 자동 분석하지 않으며, 음악
              끝은 출력에서 0.25초 동안 줄여요.
            </p>
          </fieldset>
          <details className="panel card-news-evidence">
            <summary>추천의 근거와 성과 사례</summary>
            <p>
              2026.10.29 공개 화면 확인. 아래는 누적 조회수이며 음악·길이가
              성과의 원인이라는 실험 결과는 아니에요. 2024년 게시물의 짧은 목록
              형식과 여러 장의 설명 카드는 구분해요.
            </p>
            <ul>
              <li>
                <a
                  href="https://www.instagram.com/reel/DAWPltjoL_S/"
                  target="_blank"
                  rel="noreferrer"
                >
                  영화 목록 · 318만 조회 · 5.87초
                </a>{" "}
                — Sydney Ross Mitchell, The Edge.
              </li>
              <li>
                <a
                  href="https://www.instagram.com/reel/DAG0LfhILvJ/"
                  target="_blank"
                  rel="noreferrer"
                >
                  월별 신혼여행지 · 76.7만 조회 · 5.22초
                </a>{" "}
                — profgampo 오리지널 오디오.
              </li>
              <li>
                <a
                  href="https://www.youtube.com/watch?v=As7abwNhG7Y&t=427s"
                  target="_blank"
                  rel="noreferrer"
                >
                  Jenny Hoyos 인터뷰 · 마지막 구간의 이탈을 보고 편집
                </a>
              </li>
              <li>
                <a
                  href="https://www.youtube.com/watch?v=1fYbulD8EMM&t=264s"
                  target="_blank"
                  rel="noreferrer"
                >
                  Katie Steckly · 시청자와 메시지에 맞는 음악 선택
                </a>
              </li>
            </ul>
            <p>
              글자 수 기반 추천은 공백 제외 12자/초에 여유 0.5초를 더한 편집
              가정이에요. 숫자 비교는 최소 6초, 행동 안내는 5초에서 시작해요.
              실제 이해도·시청시간·저장·공유 반응을 보고 조정해주세요.
            </p>
          </details>
        </div>
      </div>
    </section>
  );
}
