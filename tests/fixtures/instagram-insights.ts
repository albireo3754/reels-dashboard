import type {
  InstagramInsightsState,
  InstagramPost,
  InstagramSnapshot,
} from "../../src/shared/instagram-insights";
export const snapshotId = "11111111-1111-4111-8111-111111111111";
export function fixturePost(
  id: string,
  publishedAt: string,
  values: Record<string, number> = {},
  kind = "REELS",
): InstagramPost {
  return {
    id,
    permalink: `https://www.instagram.com/reel/Example${id}/`,
    publishedAt,
    mediaType: kind === "REELS" ? "VIDEO" : "CAROUSEL_ALBUM",
    mediaProductType: kind,
    captionHead: `합성 게시물 ${id}`,
    metrics: Object.entries({
      views: 500,
      reach: 100,
      likes: 10,
      comments: 1,
      saved: 4,
      shares: 5,
      ...values,
    }).map(([metric, value]) => ({
      metric,
      value,
      status: "available",
      observedAt: "2026-11-13T08:00:00.000Z",
      period: "lifetime",
    })),
  };
}
export function fixtureSnapshot(): InstagramSnapshot {
  return {
    schemaVersion: 1,
    source: "manual",
    id: snapshotId,
    collectedAt: "2026-11-13T08:00:00.000Z",
    completedAt: "2026-11-13T08:01:00.000Z",
    apiVersion: "v27.0",
    login: "unified",
    account: {
      userId: "10001",
      username: "creator_demo",
      followersCount: 200,
      mediaCount: 4,
    },
    ownedMediaCount: 4,
    media: [
      fixturePost("101", "2026-09-24T12:00:00+00:00"),
      fixturePost("102", "2026-11-13T07:00:00+00:00"),
      fixturePost("103", "2026-11-01T10:00:00+00:00", {
        likes: 5,
        comments: 0,
        saved: 3,
        shares: 2,
      }),
      fixturePost("104", "2026-10-01T10:00:00+00:00", {}, "FEED"),
    ],
  };
}
export function fixtureInsightsState(): InstagramInsightsState {
  const snapshot = fixtureSnapshot();
  return {
    connection: {
      username: "creator_demo",
      login: "unified",
      tokenReady: true,
    },
    snapshot,
    history: [
      {
        id: snapshot.id,
        collectedAt: snapshot.collectedAt,
        count: snapshot.media.length,
      },
    ],
    topics: { 101: "체험", 103: "풍경" },
    busy: false,
  };
}
