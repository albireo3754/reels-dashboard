const graphOrigin = 'https://graph.instagram.com';
export const CORE_METRICS = ['views', 'reach', 'likes', 'comments', 'saved', 'shares'];
export const REEL_METRICS = ['ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate'];
export class InstagramApiError extends Error {
  constructor(status, code, subcode) {
    super(`Instagram API request failed (HTTP ${status}, code ${code ?? 'unknown'})`);
    this.name = 'InstagramApiError'; this.status = status; this.code = code; this.subcode = subcode;
  }
}
export function instagramShortcode(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid Instagram permalink');
  const match = /\/(?:p|reel)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error('Invalid Instagram permalink');
  return match[1];
}
export class InstagramInsightsClient {
  #token; #fetch;
  constructor({accessToken, apiVersion = 'v26.0', expectedUsername = 'rosy_trip2', fetchImpl = fetch}) {
    if (typeof accessToken !== 'string' || !accessToken.trim()) throw new Error('Instagram access token is required');
    if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error('Invalid API version');
    this.#token = accessToken; this.#fetch = fetchImpl; this.apiVersion = apiVersion; this.expectedUsername = expectedUsername;
  }
  async #get(endpoint, parameters = {}) {
    if (!/^(me|\d+(?:\/(?:media|insights))?)$/.test(endpoint)) throw new Error('Invalid Instagram endpoint');
    const url = new URL(`/${this.apiVersion}/${endpoint}`, graphOrigin);
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try { response = await this.#fetch(url, {headers: {Authorization: `Bearer ${this.#token}`}, redirect: 'error', signal: AbortSignal.timeout(20000)}); }
    catch { throw new InstagramApiError(0, 'NETWORK_OR_TIMEOUT'); }
    let data;
    try { data = await response.json(); } catch { throw new InstagramApiError(response.status, 'INVALID_RESPONSE'); }
    if (!response.ok || data?.error) throw new InstagramApiError(response.status, data?.error?.code, data?.error?.error_subcode);
    return data;
  }
  async account() {
    const response = await this.#get('me', {fields: 'user_id,username'});
    const account = Array.isArray(response.data) ? response.data.length === 1 ? response.data[0] : null : response;
    if (!account || typeof account.user_id !== 'string' || !/^\d+$/.test(account.user_id) || account.username !== this.expectedUsername) throw new Error('ACCOUNT_MISMATCH: The authenticated Instagram account is not the expected owner');
    return {userId: account.user_id, username: account.username};
  }
  async media(account) {
    if (account.username !== this.expectedUsername || !/^\d+$/.test(account.userId)) throw new Error('ACCOUNT_MISMATCH');
    const items = []; let after; const cursors = new Set();
    for (let page = 0; page < 20; page++) {
      const response = await this.#get(`${account.userId}/media`, {fields: 'id,media_type,media_product_type,permalink,timestamp', limit: 50, after});
      if (!Array.isArray(response.data)) throw new Error('Invalid media list');
      for (const item of response.data) {
        if (typeof item.id !== 'string' || !/^\d+$/.test(item.id) || typeof item.permalink !== 'string') throw new Error('Invalid media metadata');
        instagramShortcode(item.permalink);
        items.push({id: item.id, permalink: item.permalink, mediaType: item.media_type, mediaProductType: item.media_product_type, publishedAt: item.timestamp});
      }
      // Never follow an API paging URL, which may contain credentials or another origin.
      if (!response.paging?.next) return items;
      after = response.paging?.cursors?.after;
      if (typeof after !== 'string' || !after || cursors.has(after)) throw new Error('Invalid pagination cursor');
      cursors.add(after);
    }
    throw new Error('MEDIA_PAGE_LIMIT: Narrow the requested collection before continuing');
  }
  async insights(media, metrics = CORE_METRICS) {
    if (!/^\d+$/.test(media.id) || !Array.isArray(metrics) || !metrics.length || metrics.some(m => ![...CORE_METRICS, ...REEL_METRICS].includes(m))) throw new Error('Invalid insights request');
    const values = [];
    for (const metric of [...new Set(metrics)]) {
      const observedAt = new Date().toISOString();
      try {
        const response = await this.#get(`${media.id}/insights`, {metric});
        if (!Array.isArray(response.data)) throw new Error('Invalid insights response');
        const item = response.data.find(x => x.name === metric);
        const value = item?.total_value?.value ?? item?.values?.[0]?.value;
        values.push({metric, observedAt, status: typeof value === 'number' && Number.isFinite(value) ? 'available' : 'unavailable', value: typeof value === 'number' && Number.isFinite(value) ? value : null, period: item?.period ?? null});
      } catch (error) {
        if (!(error instanceof InstagramApiError)) throw error;
        if (error.code === 190 || error.status === 401) throw error;
        const status = [4,17,32,613].includes(error.code) || error.status === 429 ? 'rate_limited' : [10,200].includes(error.code) ? 'permission_denied' : 'api_error';
        values.push({metric, observedAt, status, value: null, errorCode: error.code ?? null, errorSubcode: error.subcode ?? null});
        if (status === 'rate_limited') break;
      }
    }
    return {mediaId: media.id, permalink: media.permalink, apiVersion: this.apiVersion, metrics: values};
  }
  async inspectPermalink(permalink) {
    const account = await this.account();
    const media = await this.media(account);
    const shortcode = instagramShortcode(permalink);
    const selected = media.find(m => instagramShortcode(m.permalink) === shortcode);
    if (!selected) throw new Error('MEDIA_NOT_FOUND: The requested post was not returned for this account');
    return {account, media: selected, ownedMediaCount: media.length, insights: await this.insights(selected)};
  }
}
