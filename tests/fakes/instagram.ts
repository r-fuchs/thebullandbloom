import type { FetchedImage, IgMedia, IgToken, Instagram } from "../../src/adapters/instagram";

/** A recorded three-post feed (shapes from the Instagram API with Instagram Login). */
export const RECORDED_FEED: IgMedia[] = [
  { id: "18001", mediaType: "IMAGE", mediaUrl: "https://cdn.test/18001.jpg", permalink: "https://www.instagram.com/p/aaa/", caption: "Tuesday's bouquets, out the door.", timestamp: "2026-09-08T14:05:00+0000" },
  { id: "18002", mediaType: "VIDEO", mediaUrl: "https://cdn.test/18002.mp4", thumbnailUrl: "https://cdn.test/18002-thumb.jpg", permalink: "https://www.instagram.com/reel/bbb/", caption: "Wrapping.", timestamp: "2026-09-06T18:30:00+0000" },
  { id: "18003", mediaType: "CAROUSEL_ALBUM", mediaUrl: "https://cdn.test/18003.jpg", permalink: "https://www.instagram.com/p/ccc/", timestamp: "2026-09-02T12:00:00+0000" },
];

export class FakeInstagram implements Instagram {
  isConfigured = true;
  feed: IgMedia[] = RECORDED_FEED.map((m) => ({ ...m }));
  fetched: string[] = [];
  refreshed = 0;
  failNext: string | null = null;
  expiresIn = 60 * 86400;

  configured() { return this.isConfigured; }
  authUrl(state: string, redirectUri: string) {
    return `https://www.instagram.test/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(code: string): Promise<IgToken> {
    this.maybeFail();
    if (code !== "good-code") throw new Error("invalid code");
    return { accessToken: "ig_long_fake", expiresAt: Math.floor(Date.now() / 1000) + this.expiresIn, userId: "17841400000", username: "thebullandbloom" };
  }
  async whoAmI(accessToken: string) {
    this.maybeFail();
    if (!accessToken.startsWith("IGAA")) throw new Error("instagram me: 400 invalid token");
    return { userId: "17841400000", username: "thebullandbloom" };
  }
  async refreshToken(token: IgToken): Promise<IgToken> {
    this.maybeFail(); this.refreshed += 1;
    return { ...token, accessToken: token.accessToken + "_r", expiresAt: token.expiresAt + this.expiresIn };
  }
  async recentMedia(_token: IgToken, limit: number) { this.maybeFail(); return this.feed.slice(0, limit); }
  async fetchImage(url: string): Promise<FetchedImage> {
    this.maybeFail(); this.fetched.push(url);
    return { bytes: new TextEncoder().encode(`img:${url}`).buffer as ArrayBuffer, contentType: "image/jpeg" };
  }
  private maybeFail() { if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); } }
}
