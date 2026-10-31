import { z } from "zod";

const point = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const text = z.string().max(500);
const asset = z.object({
  name: z.string().min(1).max(255).refine((v) => !/[\\/\0]/.test(v), "파일명만 사용해주세요."),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
  kind: z.enum(["video", "photo"]),
  duration: z.number().finite().min(0).max(86400),
  point,
  accuracy: z.number().finite().nullable(),
  uncertain: z.boolean(),
  section: text,
});
/** Deliberately strips source paths, previews, and unknown fields before sync. */
export const routeMapSchema = z.object({
  schemaVersion: z.literal(1),
  captureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).max(80),
  assets: z.array(asset).min(1).max(5000),
  ways: z.array(z.object({ points: z.array(point).min(2).max(10000), kind: text })).max(10000),
  legs: z.array(z.object({ points: z.array(point).max(10000), status: text })).max(5000),
  pois: z.array(z.object({ name: text, point })).max(1000),
  attribution: z.string().min(1).max(500),
  routeStatus: z.string().min(1).max(2000),
}).superRefine((value, ctx) => {
  const names = new Set<string>();
  value.assets.forEach((a, i) => {
    if (names.has(a.name)) ctx.addIssue({ code: "custom", path: ["assets", i, "name"], message: "촬영 파일명이 중복됐어요." });
    names.add(a.name);
    if (i && a.time < value.assets[i - 1].time) ctx.addIssue({ code: "custom", path: ["assets", i, "time"], message: "촬영시각 순서로 정리해주세요." });
  });
});
export type RouteMapData = z.infer<typeof routeMapSchema>;
export interface LocalRouteMap { data: RouteMapData; mediaByName: Record<string, string>; }
export interface RouteMapBridge { load(projectId: string): Promise<LocalRouteMap | null>; }
export const ROUTE_MAP_FILENAME = "route-map-data.json";
export function parseRouteMap(value: unknown): RouteMapData { return routeMapSchema.parse(value); }
export function routeBounds(data: RouteMapData, includeUncertain = false): [number, number, number, number] {
  let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
  const include = (p: number[]) => { x1 = Math.min(x1, p[0]); x2 = Math.max(x2, p[0]); y1 = Math.min(y1, p[1]); y2 = Math.max(y2, p[1]); };
  data.assets.filter(a => includeUncertain || !a.uncertain).forEach(a => include(a.point));
  data.pois.forEach(p => include(p.point));
  data.legs.forEach(l => l.points.forEach(include));
  if (x1 === Infinity) include(data.assets[0].point);
  const px = Math.max((x2 - x1) * .12, .0002), py = Math.max((y2 - y1) * .12, .0002);
  return [x1 - px, y1 - py, x2 + px, y2 + py];
}
