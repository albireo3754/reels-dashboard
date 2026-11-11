import { errorMessage } from "../../../shared/lib/errors";
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
import { drawCard } from "./frame";
import {
  Button,
  CloseIcon,
  Dot,
  IconButton,
  Notice,
  PlusIcon,
  Section,
  Spacer,
  StatusText,
  Toolbar,
} from "../../../shared/ui/primitives";
import { useBusy } from "../../../shared/ui/useBusy";
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
  const { busy, error, setError, notice, setNotice, run } = useBusy();
  const [dirty, setDirty] = useState(false);
  const [job, setJob] = useState<CardJob | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [align, setAlign] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
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
        throw new Error(`${i + 1}번 카드: ${errorMessage(e)}`);
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
  function select(index: number) {
    stop();
    setSelected(index);
    setCursor(segments[index]?.start ?? 0);
  }
  function remove(index: number) {
    change({ ...plan, cards: plan.cards.filter((_, n) => n !== index) });
    // 펼친 카드가 그대로 펼쳐져 있도록, 앞 카드를 지우면 한 칸 당기고 끝 카드를 지우면 마지막으로 맞춘다.
    setSelected((s) =>
      index < s ? s - 1 : Math.min(s, plan.cards.length - 2),
    );
  }
  function addCard() {
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
    });
    setSelected(plan.cards.length);
  }
  const status = busy
    ? "처리 중"
    : notice || (dirty ? "저장 안 됨" : "");
  const card = plan.cards[selected];
  const editor = card && (
    <CardEditor
      index={selected}
      card={card}
      asset={card.imageId ? assets[card.imageId] : undefined}
      disabled={disabled}
      canChoose={!!api}
      edit={(patch) => editCard(selected, patch)}
      choose={(kind) => void run(() => choose(kind, selected))}
    />
  );
  return (
    <section className="card-news" aria-label="카드뉴스 제작">
      <Toolbar divided className="card-news-header">
        <input
          className="card-news-title"
          aria-label="구성 제목"
          value={plan.title}
          maxLength={120}
          disabled={disabled}
          placeholder="제목 없는 카드뉴스"
          onChange={(e) => change({ ...plan, title: e.target.value })}
        />
        <StatusText live busy={busy} className="card-news-status">
          {status}
        </StatusText>
        <Spacer />
        <select
          className="ui-inline card-news-saved"
          aria-label="저장된 구성"
          title="저장된 구성 열기"
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
          <option value="">저장된 구성 열기</option>
          {recent.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <Button
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
        </Button>
        <Button
          variant="secondary"
          disabled={disabled || !api}
          onClick={() =>
            void run(async () => {
              await save();
              setNotice("구성을 저장했어요.");
            })
          }
        >
          구성 저장
        </Button>
      </Toolbar>
      {!api && (
        <Notice className="card-news-notice">
          브라우저에서는 문구·시간·미리보기만 연습할 수 있어요. 사진·음악 선택,
          저장, MP4 출력은 데스크톱 앱에서 제공해요.
        </Notice>
      )}
      {error && (
        <Notice tone="danger" className="card-news-error">
          {error}
        </Notice>
      )}
      <div className="card-news-layout">
        <section className="card-news-preview" aria-label="재생 미리보기">
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
          <div className="card-news-position ui-meta">
            <span data-testid="card-preview-position">
              {current + 1}번 카드 ·{" "}
              {playing
                ? cursor.toFixed(1)
                : segments[selected]?.start.toFixed(1)}
              초
            </span>
            <span data-testid="card-total">
              {total.toFixed(2)}초 · {plan.cards.length}장
            </span>
          </div>
          <div
            className="card-news-timeline"
            aria-label="카드 타임라인"
            title="사진은 중앙 기준으로 세로 화면에 맞춰요. 전환은 하드 컷이며 글자는 카드 시작과 함께 표시해요."
          >
            {segments.map((c, i) => (
              <button
                key={c.id}
                aria-label={`${i + 1}번 카드 보기`}
                aria-pressed={selected === i}
                disabled={disabled}
                style={{ flexGrow: c.frames }}
                onClick={() => select(i)}
              >
                {i + 1}
                <small>{(c.frames / 30).toFixed(1)}초</small>
              </button>
            ))}
          </div>
          <div className="card-news-actions">
            <Button
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  stop();
                  await makeFrames();
                })
              }
            >
              카드 미리보기 만들기
            </Button>
            <Button
              disabled={disabled}
              onClick={() => (playing ? stop() : void run(play))}
            >
              {playing ? "재생 멈춤" : "처음부터 재생"}
            </Button>
            <Spacer />
            <Button
              variant="primary"
              disabled={disabled || !api}
              onClick={() =>
                void run(async () => {
                  stop();
                  const invalid = plan.cards.findIndex(
                    (c) =>
                      !c.imageId ||
                      (!c.imageOnly && !c.overlayId && !c.text.trim()),
                  );
                  if (invalid >= 0) {
                    setSelected(invalid);
                    throw new Error(
                      "모든 카드에 사진 또는 영상과 문구를 넣어주세요.",
                    );
                  }
                  if (invalidMusic) throw new Error(invalidMusic);
                  const images = frames.length ? frames : await makeFrames();
                  const saved = await save();
                  const result = await api!.export(saved, images);
                  if (result) setJob(result);
                })
              }
            >
              MP4 내보내기
            </Button>
          </div>
          <p className="ui-meta">
            1080 × 1920 · 30fps · H.264{music ? " + AAC 음악" : " · 무음"}
          </p>
          {job && (
            <div role="status" className="card-news-job">
              {job.state === "running" ? (
                <>
                  <p className="ui-meta">내보내는 중 · {job.progress}%</p>
                  <progress max={100} value={job.progress} />
                  <Button
                    size="small"
                    onClick={() =>
                      void run(async () => {
                        await api!.cancel(job.id);
                        setJob(await api!.job(job.id));
                      })
                    }
                  >
                    내보내기 취소
                  </Button>
                </>
              ) : job.state === "completed" ? (
                <>
                  <h3>MP4 내보내기 완료</h3>
                  <p className="ui-meta">{job.outputPath}</p>
                  {job.error && <p className="ui-meta">{job.error}</p>}
                  <Button
                    size="small"
                    onClick={() => void run(() => api!.reveal(job.id))}
                  >
                    결과 폴더 열기
                  </Button>
                </>
              ) : (
                <p className="ui-meta">
                  {job.state === "cancelled"
                    ? "내보내기를 취소했어요."
                    : job.error}
                </p>
              )}
            </div>
          )}
        </section>
        <div className="card-news-controls">
          <fieldset className="card-news-settings" disabled={disabled}>
            <legend className="ui-sr-only">구성 설정</legend>
            <label>
              배경 어둡기 (%)
              <input
                className="ui-narrow"
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
            <Button
              size="large"
              title="6장 기본값은 3 / 3.5 / 3.5 / 6 / 5 / 3초예요. 추천은 역할과 글자 수를 고려한 시작값이며 직접 조정할 수 있어요. 박자 맞춤은 입력한 BPM 기준이에요."
              onClick={() =>
                void run(async () => change(recommendTiming(plan, align)))
              }
            >
              읽는 시간 추천 적용
            </Button>
            <label className="ui-check">
              <input
                type="checkbox"
                checked={align}
                onChange={(e) => setAlign(e.target.checked)}
              />
              읽는 시간을 지키며 박자에 맞추기
            </label>
          </fieldset>
          <p className="ui-meta card-news-fixed">
            글자 크기·굵기·행간·자간·위치는 템플릿으로 고정돼요. 문구와 줄바꿈만
            바꿔주세요.
          </p>
          <ol className="ui-list card-news-cards" aria-label="카드 목록">
            {plan.cards.map((c, i) => {
              const open = selected === i;
              const first = c.text.split("\n").find((line) => line.trim());
              const short = c.seconds < recommendedSeconds(c);
              return (
                <li
                  key={c.id}
                  className="card-news-card"
                  data-open={open || undefined}
                >
                  <div
                    className={`ui-row card-news-card-row${open ? " selected" : ""}`}
                    data-clickable
                  >
                    <button
                      className="card-news-card-open"
                      aria-label={`${i + 1}번 카드 편집`}
                      aria-expanded={open}
                      title={first ?? undefined}
                      onClick={() => select(i)}
                    >
                      <span className="card-news-card-number">{i + 1}</span>
                      <span className="ui-row-title">
                        {first ?? (
                          <span className="card-news-card-empty">
                            {cardLayouts[cardLayout(c)]} · 문구 없음
                          </span>
                        )}
                      </span>
                      {short && (
                        <Dot
                          tone="warning"
                          label={`추천 ${recommendedSeconds(c)}초보다 짧아요`}
                        />
                      )}
                      <span className="ui-row-meta">
                        {segments[i].start.toFixed(1)}–
                        {segments[i].end.toFixed(1)}초
                      </span>
                    </button>
                    <span className="ui-row-actions">
                      <IconButton
                        size="small"
                        label={`${i + 1}번 위로`}
                        disabled={disabled || i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <span aria-hidden="true">↑</span>
                      </IconButton>
                      <IconButton
                        size="small"
                        label={`${i + 1}번 아래로`}
                        disabled={disabled || i === plan.cards.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <span aria-hidden="true">↓</span>
                      </IconButton>
                      <IconButton
                        size="small"
                        label={`${i + 1}번 카드 삭제`}
                        disabled={disabled || plan.cards.length === 1}
                        onClick={() => remove(i)}
                      >
                        <CloseIcon />
                      </IconButton>
                    </span>
                  </div>
                  {open && editor}
                </li>
              );
            })}
          </ol>
          <Button
            className="card-news-add"
            disabled={disabled || plan.cards.length >= 20}
            onClick={addCard}
          >
            <PlusIcon />
            카드 추가
          </Button>
          <Section divided className="card-news-music">
            <fieldset disabled={disabled}>
              <legend>
                <h3 title="글을 읽기 편한 일정한 리듬, 가사가 적은 구간부터 비교해보세요. 100~120 BPM은 이번 편집의 시작 제안이며 바이럴 보장 기준은 아니에요.">
                  음악과 리듬
                </h3>
              </legend>
              <div className="card-news-line">
                <Button
                  variant="secondary"
                  disabled={!api}
                  onClick={() => void run(() => choose("audio", 0))}
                >
                  음악 파일 선택
                </Button>
                {music && (
                  <Button
                    onClick={() =>
                      change({
                        ...plan,
                        music: { ...plan.music, assetId: null, offset: 0 },
                      })
                    }
                  >
                    음악 해제
                  </Button>
                )}
                <span
                  className="ui-meta ui-truncate"
                  title="직접 준비한 음악 파일을 사용해요. BPM은 자동 분석하지 않으며, 음악 끝은 출력에서 0.25초 동안 줄여요."
                >
                  {music
                    ? `${music.name} · ${music.duration?.toFixed(1)}초`
                    : "음악 미선택 · 무음으로 내보내요."}
                </span>
              </div>
              <div className="card-news-line">
                <label>
                  음악 시작 (초)
                  <input
                    className="ui-narrow"
                    type="number"
                    min={0}
                    step={0.1}
                    value={plan.music.offset}
                    onChange={(e) =>
                      change({
                        ...plan,
                        music: {
                          ...plan.music,
                          offset: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  음악 볼륨 (%)
                  <input
                    className="ui-narrow"
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
                    className="ui-narrow"
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
                <label className="ui-check">
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
              {invalidMusic && (
                <Notice tone="warning" role="alert">
                  {invalidMusic}
                </Notice>
              )}
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
            </fieldset>
          </Section>
          <details className="card-news-evidence">
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

/** 펼친(선택한) 카드 하나의 편집기. 접힌 카드는 목록의 한 줄 요약으로만 보인다. */
function CardEditor({
  index: i,
  card,
  asset,
  disabled,
  canChoose,
  edit,
  choose,
}: {
  index: number;
  card: Card;
  asset?: CardAsset;
  disabled: boolean;
  canChoose: boolean;
  edit: (patch: Partial<Card>) => void;
  choose: (kind: "image" | "video") => void;
}) {
  const layout = cardLayout(card);
  return (
    <fieldset className="card-news-editor" disabled={disabled}>
      <legend className="ui-sr-only">{i + 1}번 카드</legend>
      <div className="card-news-line">
        <label>
          {i + 1}번 카드 종류
          <select
            className="ui-inline"
            aria-label={`${i + 1}번 카드 종류`}
            value={layout}
            onChange={(e) =>
              edit(selectCardLayout(card, e.target.value as CardLayout, i === 0))
            }
          >
            {Object.entries(cardLayouts).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {i + 1}번 노출 시간
          <input
            className="ui-narrow"
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            value={card.seconds}
            onChange={(e) => edit({ seconds: Number(e.target.value) })}
          />
        </label>
        {layout === "text" && (
          <label className="ui-check">
            <input
              type="checkbox"
              aria-label={`${i + 1}번 크게 강조`}
              checked={card.templateId === "summary"}
              onChange={(e) =>
                edit({
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
      </div>
      {(card.imageOnly || card.overlayId) && (
        <Notice tone="warning" role="alert">
          기존 커스텀 카드예요. 위에서 템플릿을 선택하면 문구로 다시 만들어요.
        </Notice>
      )}
      <label>
        {i + 1}번 문구{card.imageOnly ? " (기록용)" : ""}
        <textarea
          aria-label={`${i + 1}번 문구`}
          rows={3}
          maxLength={600}
          value={card.text}
          onChange={(e) => edit({ text: e.target.value })}
          placeholder="자연스럽게 읽히는 문장을 입력해주세요."
        />
      </label>
      {card.seconds < recommendedSeconds(card) && (
        <p className="field-help card-news-hint">
          추천 {recommendedSeconds(card)}초보다 짧아요. 읽는 속도를 미리보기로
          확인해주세요.
        </p>
      )}
      {card.templateId === "comparison" && (
        <>
          <label>
            {i + 1}번 표 머리글
            <input
              value={card.table?.columns.join(" | ") ?? ""}
              onChange={(e) => {
                const cols = e.target.value.split("|").map((x) => x.trim());
                edit({
                  table: {
                    columns: [cols[0] ?? "", cols[1] ?? "", cols[2] ?? ""],
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
                card.table?.rows.map((r) => r.join(" | ")).join("\n") ?? ""
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
                edit({
                  table: {
                    columns: card.table?.columns ?? ["항목", "이전", "이후"],
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
            onChange={(e) => edit({ signature: e.target.value })}
          />
        </label>
      )}
      <label>
        {i + 1}번 보조 설명
        <textarea
          rows={2}
          value={card.notes ?? ""}
          onChange={(e) => edit({ notes: e.target.value })}
        />
      </label>
      <div className="card-news-line card-news-media">
        <Button
          variant="secondary"
          disabled={!canChoose}
          onClick={() => choose("image")}
        >
          {i + 1}번 사진 선택
        </Button>
        <Button
          variant="secondary"
          disabled={!canChoose}
          onClick={() => choose("video")}
        >
          {i + 1}번 영상 선택
        </Button>
        <span className="ui-meta">
          {card.imageId
            ? (asset?.name ?? "사진 불러오기 필요")
            : "사진 미선택"}
        </span>
      </div>
      {asset?.kind === "video" && (
        <div className="card-news-line">
          <label>
            {i + 1}번 영상 시작 (초)
            <input
              className="ui-narrow"
              type="number"
              min={0}
              max={asset.duration}
              step={0.1}
              value={card.videoStart ?? 0}
              onChange={(e) => edit({ videoStart: Number(e.target.value) })}
            />
          </label>
          <span className="ui-meta">
            원본 {asset.duration?.toFixed(2)}초 · 선택 구간만 재생하며 원본
            소리는 사용하지 않아요.
          </span>
        </div>
      )}
    </fieldset>
  );
}
