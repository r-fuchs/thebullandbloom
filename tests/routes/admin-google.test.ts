import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp } from "../helpers";
import { clearConnection, loadState, loadConnection, saveState, saveConnection } from "../../src/store/google";
import { ORDER_PAID_KINDS, counts, enqueueForSessionStatements } from "../../src/store/outbox";

async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  expect(r.status).toBe(204);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" }, redirect: "manual" });
}
const NOW = new Date("2026-09-08T14:00:00Z");

describe("admin google", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
  });

  it("requires the admin cookie for the api routes", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/google/status")).status).toBe(401);
    expect((await fetch("/admin/api/google/start")).status).toBe(401);
    expect((await fetch("/admin/api/google/sync", { method: "POST" })).status).toBe(401);
  });

  it("reports not connected, then connects through start → callback and creates both calendars", async () => {
    const { fetch, google } = testApp(NOW);
    const api = await login(fetch);
    expect(await (await api("/admin/api/google/status")).json()).toEqual({
      configured: true, connected: false, account: null, calendars: null, connectedAt: null,
      lastSyncAt: null, lastSyncError: null, outbox: { pending: 0, failed: 0 },
    });

    const start = await api("/admin/api/google/start");
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    expect(loc.origin).toBe("https://accounts.google.test");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${env.SITE_URL}/admin/google/callback`);
    const state = loc.searchParams.get("state")!;

    // the callback arrives WITHOUT the cookie (SameSite=Strict, D25)
    const cb = await fetch(`/admin/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/admin/?google=connected");
    expect(await loadConnection(env.DB, env.ADMIN_SECRET)).toEqual({ refreshToken: "rt_fake", account: "thebullandbloom@gmail.com" });
    expect(await loadState(env.DB)).toEqual({
      account: "thebullandbloom@gmail.com", closedCalendarId: "cal_1", ordersCalendarId: "cal_2", connectedAt: Math.floor(NOW.getTime() / 1000),
    });
    expect([...google.calendars.keys()]).toEqual(["Bull and Bloom: Closed", "Bull and Bloom: Orders"]);

    const status = await (await api("/admin/api/google/status")).json();
    expect(status).toMatchObject({ connected: true, account: "thebullandbloom@gmail.com", calendars: { closed: "cal_1", orders: "cal_2" } });
  });

  it("delivers messages queued while disconnected as soon as the callback reconnects", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id)
       VALUES ('ag2', 1, 'paid', '2026-09-29', 'bouquet', 'pickup', 'Ryan', 'ryan@example.com', 8500, 'cs_ag2')`).run();
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_ag2", ORDER_PAID_KINDS, 1));
    const { fetch, google } = testApp(NOW);
    const api = await login(fetch);
    expect((await (await api("/admin/api/google/status")).json()).outbox).toEqual({ pending: 3, failed: 0 });
    const state = new URL((await api("/admin/api/google/start")).headers.get("location")!).searchParams.get("state")!;
    const cb = await fetch(`/admin/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.headers.get("location")).toBe("/admin/?google=connected");
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    expect(google.sent).toHaveLength(2);
    expect(google.inserted).toEqual([expect.objectContaining({ calendarId: "cal_2" })]);
  });

  it("rejects a forged or expired state and reports denial", async () => {
    const { fetch } = testApp(NOW);
    expect((await fetch("/admin/google/callback?code=good-code&state=999.forged", { redirect: "manual" })).status).toBe(400);
    expect((await fetch("/admin/google/callback?code=good-code", { redirect: "manual" })).status).toBe(400);
    const api = await login(fetch);
    const state = new URL((await api("/admin/api/google/start")).headers.get("location")!).searchParams.get("state")!;
    const late = testApp(new Date(NOW.getTime() + 11 * 60_000));
    expect((await late.fetch(`/admin/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: "manual" })).status).toBe(400);
    const denied = await fetch(`/admin/google/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(denied.headers.get("location")).toBe("/admin/?google=denied");
    expect(await loadState(env.DB)).toBeNull();
  });

  it("redirects to failed when the code exchange fails, leaving nothing stored", async () => {
    const { fetch } = testApp(NOW);
    const api = await login(fetch);
    const state = new URL((await api("/admin/api/google/start")).headers.get("location")!).searchParams.get("state")!;
    const cb = await fetch(`/admin/google/callback?code=bad-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.headers.get("location")).toBe("/admin/?google=failed");
    expect(await loadState(env.DB)).toBeNull();
  });

  it("clears a saved connection when calendar creation fails after the exchange", async () => {
    const { fetch, google } = testApp(NOW);
    const api = await login(fetch);
    const state = new URL((await api("/admin/api/google/start")).headers.get("location")!).searchParams.get("state")!;
    let calls = 0;
    google.ensureCalendar = async () => { calls += 1; if (calls === 2) throw new Error("calendar api down"); return "cal_1"; };
    const cb = await fetch(`/admin/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/admin/?google=failed");
    expect(await loadConnection(env.DB, env.ADMIN_SECRET)).toBeNull();
    expect(await loadState(env.DB)).toBeNull();
  });

  it("returns 503 from start when the client is not configured", async () => {
    const { fetch, google } = testApp(NOW);
    google.isConfigured = false;
    const api = await login(fetch);
    expect((await api("/admin/api/google/start")).status).toBe(503);
    expect((await (await api("/admin/api/google/status")).json()).configured).toBe(false);
  });

  it("shows disconnected when the stored token no longer decrypts", async () => {
    await saveConnection(env.DB, "some-other-secret", { refreshToken: "rt", account: "a@b.c" });
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    const { fetch } = testApp(NOW);
    const api = await login(fetch);
    expect((await (await api("/admin/api/google/status")).json()).connected).toBe(false);
  });

  it("syncs on demand, disconnects, and retries failed outbox rows", async () => {
    await saveConnection(env.DB, env.ADMIN_SECRET, { refreshToken: "rt", account: "a@b.c" });
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 });
    const { fetch, google } = testApp(NOW);
    const api = await login(fetch);
    google.events["cal_closed"] = [{ id: "v", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } }];
    expect(await (await api("/admin/api/google/sync", { method: "POST" })).json()).toEqual({ status: "ok", added: 1, removed: 0, closed: 1 });
    expect((await (await api("/admin/api/google/status")).json()).lastSyncAt).toBe(Math.floor(NOW.getTime() / 1000));

    await env.DB.prepare(
      `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id)
       VALUES ('ag1', 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, 'cs_ag1')`).run();
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_ag1", ORDER_PAID_KINDS, 1));
    await env.DB.prepare("UPDATE outbox SET next_attempt_at = NULL, attempts = 24 WHERE order_id = 'ag1'").run();
    expect((await (await api("/admin/api/google/status")).json()).outbox).toEqual({ pending: 0, failed: 3 });
    expect(await (await api("/admin/api/google/retry", { method: "POST" })).json()).toEqual({ retried: 3, drain: { status: "ok", delivered: 3, failed: 0 } });
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    expect(google.sent).toHaveLength(2);

    await env.DB.prepare("INSERT OR REPLACE INTO day_overrides (date, source, cap, closed) VALUES ('2026-09-22', 'admin', NULL, 1)").run();

    expect((await api("/admin/api/google/disconnect", { method: "POST" })).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM day_overrides WHERE source = 'calendar'").first<any>()).n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM day_overrides WHERE date = '2026-09-22' AND source = 'admin'").first<any>()).n).toBe(1);
    expect(await loadState(env.DB)).toBeNull();
    expect((await (await api("/admin/api/google/status")).json()).connected).toBe(false);

    await env.DB.prepare("DELETE FROM day_overrides WHERE date = '2026-09-22' AND source = 'admin'").run();
  });
});
