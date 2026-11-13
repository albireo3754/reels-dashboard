export const CORE_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
];
export const REEL_METRICS = [
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "reels_skip_rate",
];
const origins = {
  instagram: "https://graph.instagram.com",
  unified: "https://graph.facebook.com",
};
export class InstagramApiError extends Error {
  constructor(status, code, subcode) {
    code =
      typeof code === "number" && Number.isFinite(code)
        ? code
        : ["NETWORK_OR_TIMEOUT", "INVALID_RESPONSE"].includes(code)
          ? code
          : undefined;
    subcode =
      typeof subcode === "number" && Number.isFinite(subcode)
        ? subcode
        : undefined;
    super(
      `Instagram API request failed (HTTP ${status}, code ${code ?? "unknown"})`,
    );
    this.name = "InstagramApiError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}
const fatal = (error) =>
  error instanceof InstagramApiError &&
  (error.status === 0 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status >= 500 ||
    error.status === 429 ||
    [4, 10, 17, 32, 102, 190, 200, 613, 80002].includes(error.code));
export function instagramShortcode(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid Instagram permalink");
  const match = /\/(?:p|reel)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error("Invalid Instagram permalink");
  return match[1];
}
export class InstagramInsightsClient {
  #token;
  #fetch;
  constructor({
    accessToken,
    apiVersion = "v27.0",
    expectedUsername,
    login = "instagram",
    fetchImpl = fetch,
  }) {
    if (
      typeof accessToken !== "string" ||
      !accessToken.trim() ||
      /[^\x21-\x7e]|\*/.test(accessToken.trim())
    )
      throw new Error("A real, unmasked Instagram access token is required");
    if (!/^v\d+\.\d+$/.test(apiVersion) || !Object.hasOwn(origins, login))
      throw new Error("Invalid Instagram API configuration");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(expectedUsername))
      throw new Error("Invalid Instagram username");
    this.#token = accessToken.trim();
    this.#fetch = fetchImpl;
    this.apiVersion = apiVersion;
    this.expectedUsername = expectedUsername.toLowerCase();
    this.login = login;
  }
  async #get(endpoint, parameters = {}) {
    if (
      !/^(me(?:\/assigned_instagram_accounts)?|\d+(?:\/(?:media|insights))?)$/.test(
        endpoint,
      )
    )
      throw new Error("Invalid Instagram endpoint");
    const url = new URL(`/${this.apiVersion}/${endpoint}`, origins[this.login]);
    for (const [key, value] of Object.entries(parameters))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${this.#token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new InstagramApiError(0, "NETWORK_OR_TIMEOUT");
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new InstagramApiError(response.status, "INVALID_RESPONSE");
    }
    if (!response.ok || data?.error)
      throw new InstagramApiError(
        response.status,
        data?.error?.code,
        data?.error?.error_subcode,
      );
    return data;
  }
  async #pages(endpoint, fields) {
    const items = [];
    let after;
    const cursors = new Set();
    for (let page = 0; page < 20; page++) {
      const response = await this.#get(endpoint, { fields, limit: 50, after });
      if (!Array.isArray(response.data))
        throw new Error("Invalid Instagram list");
      items.push(...response.data);
      // Rebuild the request from an opaque cursor; never follow credential-bearing next URLs.
      if (!response.paging?.next) return items;
      after = response.paging?.cursors?.after;
      if (typeof after !== "string" || !after || cursors.has(after))
        throw new Error("Invalid pagination cursor");
      cursors.add(after);
    }
    throw new Error(
      "MEDIA_PAGE_LIMIT: Narrow the requested collection before continuing",
    );
  }
  async account() {
    let response;
    if (this.login === "unified") {
      const matches = (
        await this.#pages("me/assigned_instagram_accounts", "id,username")
      ).filter((x) => x.username === this.expectedUsername);
      if (matches.length !== 1 || !/^\d+$/.test(matches[0].id))
        throw new Error(
          "ACCOUNT_MISMATCH: Expected one assigned Instagram account",
        );
      response = await this.#get(matches[0].id, {
        fields: "id,username,followers_count,media_count",
      });
    } else {
      response = await this.#get("me", {
        fields: "user_id,username,followers_count,media_count",
      });
    }
    const account = Array.isArray(response.data)
      ? response.data.length === 1
        ? response.data[0]
        : null
      : response;
    const id = this.login === "unified" ? account?.id : account?.user_id;
    if (
      !account ||
      typeof id !== "string" ||
      !/^\d+$/.test(id) ||
      account.username !== this.expectedUsername
    )
      throw new Error(
        "ACCOUNT_MISMATCH: The authenticated Instagram account is not the expected owner",
      );
    return {
      userId: id,
      username: account.username,
      followersCount: Number.isFinite(account.followers_count)
        ? account.followers_count
        : null,
      mediaCount: Number.isFinite(account.media_count)
        ? account.media_count
        : null,
    };
  }
  async media(account) {
    if (
      account.username !== this.expectedUsername ||
      !/^\d+$/.test(account.userId)
    )
      throw new Error("ACCOUNT_MISMATCH");
    const items = await this.#pages(
      `${account.userId}/media`,
      "id,caption,media_type,media_product_type,permalink,timestamp",
    );
    const seen = new Set();
    return items.map((item) => {
      if (
        typeof item.id !== "string" ||
        !/^\d+$/.test(item.id) ||
        typeof item.permalink !== "string" ||
        !Number.isFinite(Date.parse(item.timestamp)) ||
        seen.has(item.id)
      )
        throw new Error("Invalid or duplicate media metadata");
      instagramShortcode(item.permalink);
      seen.add(item.id);
      return {
        id: item.id,
        permalink: item.permalink,
        mediaType: item.media_type,
        mediaProductType: item.media_product_type,
        publishedAt: new Date(item.timestamp).toISOString(),
        captionHead: (item.caption ?? "").split("\n")[0].slice(0, 120),
      };
    });
  }
  async insights(media, metrics = CORE_METRICS) {
    if (
      !/^\d+$/.test(media.id) ||
      !Array.isArray(metrics) ||
      !metrics.length ||
      metrics.some((m) => ![...CORE_METRICS, ...REEL_METRICS].includes(m))
    )
      throw new Error("Invalid insights request");
    const names = [...new Set(metrics)];
    const parse = (metric, data) => {
      const item = data.find((x) => x.name === metric);
      const value = item?.values?.[0]?.value ?? item?.total_value?.value;
      const available =
        typeof value === "number" && Number.isFinite(value) && value >= 0;
      return {
        metric,
        observedAt: new Date().toISOString(),
        status: available ? "available" : "unavailable",
        value: available ? value : null,
        period: item?.period ?? null,
      };
    };
    try {
      const response = await this.#get(`${media.id}/insights`, {
        metric: names.join(","),
      });
      if (!Array.isArray(response.data))
        throw new Error("Invalid insights response");
      return {
        mediaId: media.id,
        permalink: media.permalink,
        apiVersion: this.apiVersion,
        metrics: names.map((m) => parse(m, response.data)),
      };
    } catch (error) {
      if (
        !(error instanceof InstagramApiError) ||
        fatal(error) ||
        error.status !== 400 ||
        error.code !== 100
      )
        throw error;
    }
    const values = [];
    for (const metric of names) {
      try {
        const response = await this.#get(`${media.id}/insights`, { metric });
        if (!Array.isArray(response.data))
          throw new Error("Invalid insights response");
        values.push(parse(metric, response.data));
      } catch (error) {
        if (
          !(error instanceof InstagramApiError) ||
          fatal(error) ||
          error.status !== 400 ||
          error.code !== 100
        )
          throw error;
        values.push({
          metric,
          observedAt: new Date().toISOString(),
          status: [10, 200].includes(error.code)
            ? "permission_denied"
            : "api_error",
          value: null,
          errorCode: error.code ?? null,
          errorSubcode: error.subcode ?? null,
        });
      }
    }
    return {
      mediaId: media.id,
      permalink: media.permalink,
      apiVersion: this.apiVersion,
      metrics: values,
    };
  }
  async inspectPermalink(permalink) {
    const account = await this.account();
    const media = await this.media(account);
    const shortcode = instagramShortcode(permalink);
    const selected = media.find(
      (m) => instagramShortcode(m.permalink) === shortcode,
    );
    if (!selected)
      throw new Error(
        "MEDIA_NOT_FOUND: The requested post was not returned for this account",
      );
    return {
      account,
      media: selected,
      ownedMediaCount: media.length,
      insights: await this.insights(selected),
    };
  }
}
