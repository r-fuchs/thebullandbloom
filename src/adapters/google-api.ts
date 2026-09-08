import { GoogleNotConnected, type CalendarEvent, type Connection, type Google, type Mail, type NewAllDayEvent } from "./google";
import type { ConnectionSource } from "../store/google";
import { addDays } from "../core/time";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL = "https://www.googleapis.com/calendar/v3";
const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const FROM_NAME = "The Bull and Bloom";
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function wrap76(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?utf-8?B?${b64(enc.encode(s))}?=`;
}

/** RFC 2822 text/plain message, base64url-encoded as Gmail's `raw` field wants it. */
export function buildRawMessage(fromName: string, fromAddress: string, mail: Mail): string {
  const lines = [
    `From: ${encodeHeader(fromName)} <${fromAddress}>`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(enc.encode(mail.text))),
  ];
  return b64url(enc.encode(lines.join("\r\n")));
}

export function decodeIdTokenEmail(idToken: string): string {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("google: malformed id_token");
  const claims = JSON.parse(dec.decode(unb64url(parts[1])));
  if (typeof claims.email !== "string") throw new Error("google: id_token has no email claim");
  return claims.email;
}

interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string; id_token?: string }

export class GoogleApi implements Google {
  private access: { refreshToken: string; token: string; expiresAt: number } | null = null;

  constructor(
    private clientId: string | undefined,
    private clientSecret: string | undefined,
    private source: ConnectionSource,
    private fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  configured(): boolean { return Boolean(this.clientId && this.clientSecret); }

  authUrl(state: string, redirectUri: string): string {
    const u = new URL(AUTH_URL);
    u.searchParams.set("client_id", this.clientId ?? "");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<Connection> {
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (!t.refresh_token) throw new Error("google: token response has no refresh_token (was consent granted with access_type=offline?)");
    const account = decodeIdTokenEmail(t.id_token ?? "");
    this.access = { refreshToken: t.refresh_token, token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
    return { refreshToken: t.refresh_token, account };
  }

  async listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const u = new URL(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events`);
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("orderBy", "startTime");
      u.searchParams.set("maxResults", "250");
      u.searchParams.set("timeMin", timeMin.toISOString());
      u.searchParams.set("timeMax", timeMax.toISOString());
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const page = await this.api<{ items?: CalendarEvent[]; nextPageToken?: string }>("GET", u.toString());
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async ensureCalendar(summary: string, timeZone: string): Promise<string> {
    let pageToken: string | undefined;
    do {
      const u = new URL(`${CAL}/users/me/calendarList`);
      u.searchParams.set("minAccessRole", "owner");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const page = await this.api<{ items?: Array<{ id: string; summary: string }>; nextPageToken?: string }>("GET", u.toString());
      const hit = (page.items ?? []).find((c) => c.summary === summary);
      if (hit) return hit.id;
      pageToken = page.nextPageToken;
    } while (pageToken);
    const created = await this.api<{ id: string }>("POST", `${CAL}/calendars`, { summary, timeZone });
    return created.id;
  }

  async insertAllDayEvent(calendarId: string, event: NewAllDayEvent): Promise<string> {
    const body = {
      id: event.id, summary: event.summary, description: event.description,
      start: { date: event.date }, end: { date: addDays(event.date, 1) },
    };
    await this.api("POST", `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, body, [409]);
    return event.id;
  }

  async sendMail(mail: Mail): Promise<void> {
    const { account } = await this.accessToken();
    await this.api("POST", GMAIL_SEND, { raw: buildRawMessage(FROM_NAME, account, mail) });
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const form = new URLSearchParams({ ...params, client_id: this.clientId ?? "", client_secret: this.clientSecret ?? "" });
    const r = await this.fetchFn(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const text = await r.text();
    if (!r.ok) throw new Error(`google token ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as TokenResponse;
  }

  private async accessToken(): Promise<{ token: string; account: string }> {
    const conn = await this.source.load();
    if (!conn) throw new GoogleNotConnected();
    if (!this.access || this.access.refreshToken !== conn.refreshToken || this.access.expiresAt <= Date.now()) {
      const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: conn.refreshToken });
      this.access = { refreshToken: conn.refreshToken, token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
    }
    return { token: this.access.token, account: conn.account };
  }

  /** Authenticated JSON call. Retries once after a 401 with a fresh access token. `okAlso` statuses are accepted as success. */
  private async api<T = unknown>(method: string, url: string, body?: unknown, okAlso: number[] = []): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const { token } = await this.accessToken();
      const r = await this.fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401 && attempt === 0) { this.access = null; continue; }
      const text = await r.text();
      if (r.ok || okAlso.includes(r.status)) return (text ? JSON.parse(text) : {}) as T;
      throw new Error(`google ${method} ${new URL(url).pathname} ${r.status}: ${text.slice(0, 300)}`);
    }
  }
}
