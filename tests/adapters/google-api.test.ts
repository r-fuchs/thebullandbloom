import { describe, it, expect } from "vitest";
import { GoogleApi, buildRawMessage, decodeIdTokenEmail } from "../../src/adapters/google-api";
import { GoogleNotConnected } from "../../src/adapters/google";

type Canned = { status: number; body: unknown };
function fakeFetch(script: Canned[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
    const next = script.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}
const source = (conn: { refreshToken: string; account: string } | null) => ({ load: async () => conn });
const CONN = { refreshToken: "rt_1", account: "thebullandbloom@gmail.com" };
const TOKEN = { status: 200, body: { access_token: "at_1", expires_in: 3600 } };

function b64url(s: string) { return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

describe("GoogleApi", () => {
  it("reports configured only with both client values", () => {
    expect(new GoogleApi("id", "secret", source(null)).configured()).toBe(true);
    expect(new GoogleApi(undefined, "secret", source(null)).configured()).toBe(false);
    expect(new GoogleApi("id", "", source(null)).configured()).toBe(false);
  });

  it("builds the consent url with offline access and forced consent", () => {
    const u = new URL(new GoogleApi("id-1", "s", source(null)).authUrl("st", "https://x.test/cb"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("id-1");
    expect(u.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/gmail.send", "openid", "email",
    ]));
  });

  it("exchanges a code for a refresh token and reads the account from the id token", async () => {
    const idToken = `h.${b64url(JSON.stringify({ email: "thebullandbloom@gmail.com" }))}.s`;
    const { fn, calls } = fakeFetch([{ status: 200, body: { access_token: "at", refresh_token: "rt_new", expires_in: 3600, id_token: idToken } }]);
    const g = new GoogleApi("id-1", "sec-1", source(null), fn);
    expect(await g.exchangeCode("the-code", "https://x.test/cb")).toEqual({ refreshToken: "rt_new", account: "thebullandbloom@gmail.com" });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(calls[0].body!);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("client_id")).toBe("id-1");
    expect(form.get("client_secret")).toBe("sec-1");
    expect(form.get("redirect_uri")).toBe("https://x.test/cb");
  });

  it("refuses an exchange that returns no refresh token", async () => {
    const { fn } = fakeFetch([{ status: 200, body: { access_token: "at", expires_in: 3600, id_token: "a.b.c" } }]);
    await expect(new GoogleApi("i", "s", source(null), fn).exchangeCode("c", "r")).rejects.toThrow(/refresh_token/);
  });

  it("throws GoogleNotConnected before any network call when there is no connection", async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(new GoogleApi("i", "s", source(null), fn).sendMail({ to: "a@b.c", subject: "s", text: "t" })).rejects.toBeInstanceOf(GoogleNotConnected);
    expect(calls).toHaveLength(0);
  });

  it("refreshes once, reuses the access token, and re-refreshes after a 401", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [], nextPageToken: undefined } },
      { status: 200, body: { items: [] } },
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { access_token: "at_2", expires_in: 3600 } },
      { status: 200, body: { items: [] } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    await g.listEvents("cal", new Date(0), new Date(1000));
    await g.listEvents("cal", new Date(0), new Date(1000));
    await g.listEvents("cal", new Date(0), new Date(1000));
    const tokenCalls = calls.filter((c) => c.url === "https://oauth2.googleapis.com/token");
    expect(tokenCalls).toHaveLength(2);
    expect(new URLSearchParams(tokenCalls[0].body!).get("grant_type")).toBe("refresh_token");
    expect(calls[1].headers.authorization).toBe("Bearer at_1");
    expect(calls[5].headers.authorization).toBe("Bearer at_2");
  });

  it("lists events across pages with singleEvents and the time window", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [{ id: "e1", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }], nextPageToken: "p2" } },
      { status: 200, body: { items: [{ id: "e2", start: { date: "2026-09-12" }, end: { date: "2026-09-13" } }] } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    const evs = await g.listEvents("my cal@group", new Date("2026-09-08T00:00:00Z"), new Date("2026-12-07T00:00:00Z"));
    expect(evs.map((e) => e.id)).toEqual(["e1", "e2"]);
    const u1 = new URL(calls[1].url), u2 = new URL(calls[2].url);
    expect(u1.pathname).toBe("/calendar/v3/calendars/my%20cal%40group/events");
    expect(u1.searchParams.get("singleEvents")).toBe("true");
    expect(u1.searchParams.get("timeMin")).toBe("2026-09-08T00:00:00.000Z");
    expect(u1.searchParams.get("timeMax")).toBe("2026-12-07T00:00:00.000Z");
    expect(u2.searchParams.get("pageToken")).toBe("p2");
  });

  it("finds an existing calendar by name, else creates one", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [{ id: "c-closed", summary: "Bull and Bloom: Closed" }] } },
      { status: 200, body: { items: [{ id: "c-closed", summary: "Bull and Bloom: Closed" }] } },
      { status: 200, body: { id: "c-orders", summary: "Bull and Bloom: Orders" } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    expect(await g.ensureCalendar("Bull and Bloom: Closed", "America/New_York")).toBe("c-closed");
    expect(await g.ensureCalendar("Bull and Bloom: Orders", "America/New_York")).toBe("c-orders");
    expect(calls[3].method).toBe("POST");
    expect(calls[3].url).toBe("https://www.googleapis.com/calendar/v3/calendars");
    expect(JSON.parse(calls[3].body!)).toEqual({ summary: "Bull and Bloom: Orders", timeZone: "America/New_York" });
  });

  it("inserts an all-day event with our id and treats 409 as success (D21)", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { id: "bbabc" } },
      { status: 409, body: { error: { message: "The requested identifier already exists." } } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    const ev = { id: "bbabc", date: "2026-09-10", summary: "Bouquet · Pat · pickup", description: "d" };
    expect(await g.insertAllDayEvent("cal", ev)).toBe("bbabc");
    expect(await g.insertAllDayEvent("cal", ev)).toBe("bbabc");
    expect(JSON.parse(calls[1].body!)).toEqual({
      id: "bbabc", summary: "Bouquet · Pat · pickup", description: "d",
      start: { date: "2026-09-10" }, end: { date: "2026-09-11" },
    });
  });

  it("sends mail as a base64url raw message from the connected account", async () => {
    const { fn, calls } = fakeFetch([TOKEN, { status: 200, body: { id: "m1" } }]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    await g.sendMail({ to: "pat@example.com", subject: "Hi", text: "Body" });
    expect(calls[1].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const raw = JSON.parse(calls[1].body!).raw as string;
    expect(raw).toBe(buildRawMessage("The Bull and Bloom", "thebullandbloom@gmail.com", { to: "pat@example.com", subject: "Hi", text: "Body" }));
  });

  it("surfaces non-2xx responses as errors with status and body", async () => {
    const { fn } = fakeFetch([TOKEN, { status: 403, body: { error: { message: "Insufficient Permission" } } }]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    await expect(g.sendMail({ to: "a@b.c", subject: "s", text: "t" })).rejects.toThrow(/403.*Insufficient Permission/);
  });
});

describe("buildRawMessage", () => {
  function decode(raw: string) {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    return decodeURIComponent(escape(atob(b64)));
  }
  it("emits the headers and a base64 utf-8 body", () => {
    const msg = decode(buildRawMessage("The Bull and Bloom", "shop@example.com", { to: "pat@example.com", subject: "Your bouquet", text: "Hi Pat,\n\nThanks." }));
    const [head, body] = msg.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "From: The Bull and Bloom <shop@example.com>",
      "To: pat@example.com",
      "Subject: Your bouquet",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(decodeURIComponent(escape(atob(body.replace(/\r\n/g, ""))))).toBe("Hi Pat,\n\nThanks.");
  });
  it("encodes a non-ascii subject per RFC 2047", () => {
    const msg = decode(buildRawMessage("N", "n@example.com", { to: "a@b.c", subject: "Bouquet · José", text: "x" }));
    const subject = msg.split("\r\n").find((l) => l.startsWith("Subject: "))!;
    expect(subject).toMatch(/^Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const inner = subject.slice("Subject: =?utf-8?B?".length, -2);
    expect(decodeURIComponent(escape(atob(inner)))).toBe("Bouquet · José");
  });
});

describe("decodeIdTokenEmail", () => {
  it("reads the email claim", () => {
    expect(decodeIdTokenEmail(`x.${b64url(JSON.stringify({ sub: "1", email: "a@b.c" }))}.y`)).toBe("a@b.c");
  });
  it("throws when the claim is missing", () => {
    expect(() => decodeIdTokenEmail(`x.${b64url("{}")}.y`)).toThrow(/email/);
  });
});
