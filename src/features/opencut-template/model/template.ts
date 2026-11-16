// Own style contract, verified against OpenCut Classic project schema 28.
export const travelCaptionTemplate = {
  id: "travel-caption-v1",
  name: "여행·맛집 자막 소개",
  schemaVersion: 28,
  canvas: { width: 1080, height: 1920 },
  fps: 30,
  audio: "none",
  maxStillSeconds: 3,
  layers: {
    title: {
      y: -690,
      size: 5,
      scale: 0.62,
      color: "#ffffff",
      background: "#000000b3",
    },
    place: {
      y: -605,
      size: 5,
      scale: 0.62,
      color: "#111111",
      background: "#ffffff",
    },
    caption: {
      y: 400,
      size: 4.7,
      scale: 0.55,
      color: "#ffffff",
      background: "#000000aa",
    },
    note: {
      y: 565,
      size: 3,
      scale: 0.5,
      color: "#ffffff",
      background: "#000000aa",
    },
  },
} as const;

export const foodFocusTemplate = {
  ...travelCaptionTemplate,
  id: "food-focus-v1",
  name: "음식 중심 자막 소개",
  titleOnEdgesSeconds: 3,
  layers: {
    title: {
      y: -745,
      size: 6.2,
      scale: 0.64,
      color: "#211610",
      background: "#fff1dc",
    },
    place: {
      y: -638,
      size: 4.4,
      scale: 0.63,
      color: "#fff1dc",
      background: "#1a1513e8",
    },
    caption: {
      y: 486,
      size: 4.9,
      scale: 0.56,
      color: "#ffffff",
      background: "#1a1513db",
    },
    note: {
      y: 605,
      size: 4,
      scale: 0.55,
      color: "#ffe1af",
      background: "#1a1513e8",
    },
  },
} as const;

export const letterboxShortsTemplate = {
  ...travelCaptionTemplate,
  id: "letterbox-shorts-v1",
  name: "가로 영상·상하단 자막 쇼츠",
  fps: 60,
  audio: "source",
  showPlace: false,
  videoViewport: { width: 1080, height: 608 },
  layers: {
    title: {
      y: -505,
      size: 6.4,
      scale: 0.66,
      color: "#ffffff",
      background: "#000000",
    },
    place: travelCaptionTemplate.layers.place,
    caption: {
      y: 465,
      size: 5,
      scale: 0.6,
      color: "#ffffff",
      background: "#000000",
    },
    note: {
      y: 595,
      size: 3.4,
      scale: 0.55,
      color: "#dddddd",
      background: "#000000",
    },
  },
} as const;

export const openCutTemplates = {
  [travelCaptionTemplate.id]: travelCaptionTemplate,
  [foodFocusTemplate.id]: foodFocusTemplate,
  [letterboxShortsTemplate.id]: letterboxShortsTemplate,
} as const;
export type OpenCutTemplate =
  (typeof openCutTemplates)[keyof typeof openCutTemplates];
