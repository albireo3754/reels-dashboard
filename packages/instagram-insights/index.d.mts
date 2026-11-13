export type InstagramLogin = "instagram" | "unified";
export interface InstagramAccount {
  userId: string;
  username: string;
  followersCount: number | null;
  mediaCount: number | null;
}
export interface InstagramMedia {
  id: string;
  permalink: string;
  mediaType: string;
  mediaProductType: string;
  publishedAt: string;
  captionHead: string;
}
export interface InstagramMetric {
  metric: string;
  observedAt: string;
  status: "available" | "unavailable" | "permission_denied" | "api_error";
  value: number | null;
  period?: string | null;
  errorCode?: number | string | null;
  errorSubcode?: number | null;
}
export const CORE_METRICS: string[];
export const REEL_METRICS: string[];
export function instagramShortcode(value: string): string;
export class InstagramApiError extends Error {
  status: number;
  code?: number | string;
  subcode?: number;
  constructor(status: number, code?: number | string, subcode?: number);
}
export class InstagramInsightsClient {
  readonly apiVersion: string;
  constructor(options: {
    accessToken: string;
    apiVersion?: string;
    expectedUsername: string;
    login?: InstagramLogin;
    fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  });
  account(): Promise<InstagramAccount>;
  media(
    account: Pick<InstagramAccount, "userId" | "username">,
  ): Promise<InstagramMedia[]>;
  insights(
    media: Pick<InstagramMedia, "id" | "permalink">,
    metrics?: string[],
  ): Promise<{
    mediaId: string;
    permalink: string;
    apiVersion: string;
    metrics: InstagramMetric[];
  }>;
  inspectPermalink(
    permalink: string,
  ): Promise<{
    account: InstagramAccount;
    media: InstagramMedia;
    ownedMediaCount: number;
    insights: {
      mediaId: string;
      permalink: string;
      apiVersion: string;
      metrics: InstagramMetric[];
    };
  }>;
}
