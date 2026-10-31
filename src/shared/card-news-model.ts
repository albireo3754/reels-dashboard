import { cardPlanSchema, type Card, type CardPlan } from "./card-news";

export const baseSeconds: Record<Card["role"], number> = {
  hook: 3,
  explanation: 3.5,
  audience: 3.5,
  comparison: 6,
  action: 5,
  follow: 3,
};
export function newCardPlan(): CardPlan {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    title: "새 카드뉴스 릴스",
    updatedAt: "",
    cards: (Object.keys(baseSeconds) as Card["role"][]).map((role) => ({
      id: crypto.randomUUID(),
      role,
      templateId:
        role === "hook" ? "hook" : role === "follow" ? "follow" : "body",
      text: "",
      seconds: baseSeconds[role],
      imageId: null,
    })),
    style: { fontSize: 60, darkness: 0.48 },
    music: { assetId: null, offset: 0, volume: 0.6, bpm: 120, loop: false },
  };
}
export function timeline(cards: Card[]) {
  let frame = 0;
  return cards.map((card) => {
    const startFrame = frame;
    frame += Math.round(card.seconds * 30);
    return {
      ...card,
      start: startFrame / 30,
      end: frame / 30,
      frames: frame - startFrame,
    };
  });
}
export function recommendedSeconds(card: Card): number {
  // Adjustable reading heuristic, not an empirical virality threshold.
  const characters = [...card.text.replace(/\s/g, "")].length;
  const reading = Math.ceil((characters / 12 + 0.5) * 2) / 2;
  return Math.min(30, Math.max(baseSeconds[card.role], reading));
}
export function recommendTiming(plan: CardPlan, beat: boolean): CardPlan {
  const next = {
    ...plan,
    cards: plan.cards.map((card) => {
      const minimum = recommendedSeconds(card);
      const seconds = beat
        ? (Math.ceil((minimum * plan.music.bpm) / 60 - 1e-9) * 60) /
          plan.music.bpm
        : minimum;
      return {
        ...card,
        seconds: Math.min(30, Math.ceil(seconds * 30 - 1e-9) / 30),
      };
    }),
  };
  return cardPlanSchema.parse(next);
}
export function musicError(plan: CardPlan, duration?: number): string | null {
  if (!plan.music.assetId) return null;
  if (!duration || plan.music.offset >= duration)
    return "음악 시작 시점이 곡 길이를 벗어났어요.";
  const total = timeline(plan.cards).at(-1)!.end;
  if (!plan.music.loop && plan.music.offset + total > duration + 0.02)
    return "음악이 영상보다 짧아요. 시작 시점을 당기거나 음악 반복을 선택해주세요.";
  return null;
}

export function videoError(card: Card, duration?: number): string | null {
  const end = (card.videoStart ?? 0) + Math.round(card.seconds * 30) / 30;
  return !duration || end > duration + 0.001
    ? "영상 구간이 원본 길이를 벗어나요. 시작 시점이나 카드 시간을 줄여주세요."
    : null;
}

export const cardLayouts = {
  text: "문구",
  comparison: "비교표",
  follow: "마무리",
} as const;
export type CardLayout = keyof typeof cardLayouts;
export function cardLayout(card: Card): CardLayout {
  return card.templateId === "comparison"
    ? "comparison"
    : card.templateId === "follow"
      ? "follow"
      : "text";
}
export function selectCardLayout(
  card: Card,
  layout: CardLayout,
  first: boolean,
): Card {
  return {
    ...card,
    templateId: layout === "text" ? (first ? "hook" : "body") : layout,
    role: layout === "text" ? (first ? "hook" : "explanation") : layout,
    imageOnly: false,
    overlayId: null,
    ...(layout === "comparison" && !card.table
      ? {
          table: {
            columns: ["항목", "이전", "이후"] as [string, string, string],
            rows: [["", "", ""]] as [string, string, string][],
          },
        }
      : {}),
  };
}
