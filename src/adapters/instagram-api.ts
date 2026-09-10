import type { FetchedImage, IgMedia, IgToken, Instagram } from "./instagram";

const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
export const SCOPES = ["instagram_business_basic"];
const FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";

async function json<T>(r: Response, what: string): Promise<T> {
  const text = await r.text();
  if (!r.ok) throw new Error(`instagram ${what}: ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Instagram API with Instagram Login (Business/Creator accounts), over fetch. */
export class InstagramApi implements Instagram {
  constructor(private appId: string | undefined, private appSecret: string | undefined, private fetchImpl: typeof fetch = fetch) {}

  configured(): boolean { return Boolean(this.appId && this.appSecret); }

  authUrl(state: string, redirectUri: string): string {
    const u = new URL(AUTH_URL);
    // Business Login for Instagram: force the web login page (no Facebook login, no app handoff),
    // otherwise a phone bounces into the Instagram app and never returns to the callback (2026-09-10).
    u.searchParams.set("enable_fb_login", "0");
    u.searchParams.set("force_authentication", "1");
    u.searchParams.set("client_id", this.appId ?? "");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", SCOPES.join(","));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<IgToken> {
    const form = new URLSearchParams({
      client_id: this.appId ?? "", client_secret: this.appSecret ?? "", grant_type: "authorization_code", redirect_uri: redirectUri, code,
    });
    const short = await json<{ access_token: string; user_id: string | number }>(
      await this.fetchImpl(TOKEN_URL, { method: "POST", body: form }), "code exchange");
    const long = await json<{ access_token: string; expires_in: number }>(
      await this.fetchImpl(`${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(this.appSecret ?? "")}&access_token=${encodeURIComponent(short.access_token)}`),
      "long-lived exchange");
    const me = await json<{ user_id?: string; id?: string; username: string }>(
      await this.fetchImpl(`${GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(long.access_token)}`), "me");
    return { accessToken: long.access_token, expiresAt: Math.floor(Date.now() / 1000) + long.expires_in, userId: String(me.user_id ?? me.id ?? short.user_id), username: me.username };
  }

  async refreshToken(token: IgToken): Promise<IgToken> {
    const r = await json<{ access_token: string; expires_in: number }>(
      await this.fetchImpl(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token.accessToken)}`), "refresh");
    return { ...token, accessToken: r.access_token, expiresAt: Math.floor(Date.now() / 1000) + r.expires_in };
  }

  async recentMedia(token: IgToken, limit: number): Promise<IgMedia[]> {
    const r = await json<{ data: any[] }>(
      await this.fetchImpl(`${GRAPH}/me/media?fields=${FIELDS}&limit=${limit}&access_token=${encodeURIComponent(token.accessToken)}`), "media");
    return (r.data ?? []).map((m) => ({
      id: String(m.id), mediaType: m.media_type, mediaUrl: m.media_url, thumbnailUrl: m.thumbnail_url, permalink: m.permalink, caption: m.caption, timestamp: m.timestamp,
    }));
  }

  async fetchImage(url: string): Promise<FetchedImage> {
    const r = await this.fetchImpl(url);
    if (!r.ok) throw new Error(`instagram image: ${r.status}`);
    return { bytes: await r.arrayBuffer(), contentType: r.headers.get("content-type") ?? "image/jpeg" };
  }
}
