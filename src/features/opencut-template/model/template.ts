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
export type OpenCutTemplate = typeof travelCaptionTemplate;
