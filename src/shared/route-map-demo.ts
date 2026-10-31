import type { LocalRouteMap } from "./route-map";
/** Synthetic map; never a real person's location or itinerary. */
export const demoRouteMap: LocalRouteMap = {
  data: {
    schemaVersion: 1, captureDate: "2026-10-27", timezone: "Asia/Seoul",
    assets: [
      { name: "walk.mp4", time: "10:00:00", kind: "video", duration: 3, point: [10, 20], accuracy: 5, uncertain: false, section: "예시 출발" },
      { name: "cover.png", time: "10:05:00", kind: "photo", duration: 0, point: [10.003, 20.004], accuracy: 8, uncertain: false, section: "예시 전망" },
      { name: "unlinked.mp4", time: "10:10:00", kind: "video", duration: 5, point: [10.004, 20.006], accuracy: 150, uncertain: true, section: "위치 미확인" },
    ],
    ways: [{ points: [[10, 20], [10.001, 20.002], [10.003, 20.004]], kind: "footway" }],
    legs: [{ points: [[10, 20], [10.001, 20.002], [10.003, 20.004]], status: "inferred" }],
    pois: [{ name: "예시 출발", point: [10, 20] }],
    attribution: "합성 지도 · 실제 장소 아님", routeStatus: "촬영 위치를 잇는 참고 경로예요. 실제 보행 기록이 아니에요.",
  },
  mediaByName: { "walk.mp4": "/demo/walk.mp4", "cover.png": "/demo/cover.png" },
};
