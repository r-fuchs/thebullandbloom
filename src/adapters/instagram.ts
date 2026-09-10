// Instagram behind one interface (spec §2 item 7, §4.4 "Instagram refresh"). The real
// implementation (instagram-api.ts) talks to the Instagram API with Instagram Login;
// the test fake serves a recorded feed.

export interface IgToken { accessToken: string; expiresAt: number; userId: string; username: string } // expiresAt: unix seconds
export interface IgMedia {
  id: string; mediaType: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | string;
  mediaUrl: string; thumbnailUrl?: string; permalink: string; caption?: string; timestamp: string; // ISO 8601
}
export interface FetchedImage { bytes: ArrayBuffer; contentType: string }

export class InstagramNotConnected extends Error {
  constructor() { super("instagram: not connected"); this.name = "InstagramNotConnected"; }
}

export interface Instagram {
  /** true when INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET are both set */
  configured(): boolean;
  authUrl(state: string, redirectUri: string): string;
  /** code → long-lived token (about 60 days) plus the account's username */
  exchangeCode(code: string, redirectUri: string): Promise<IgToken>;
  refreshToken(token: IgToken): Promise<IgToken>;
  recentMedia(token: IgToken, limit: number): Promise<IgMedia[]>;
  fetchImage(url: string): Promise<FetchedImage>;
}
