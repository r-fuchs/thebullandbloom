import type { App } from "../app";
import { makeSession, verifySession } from "../admin/session";
import { clearConnection, loadConnection, loadState, loadSync, saveConnection, saveState } from "../store/google";
import { counts, retryFailed } from "../store/outbox";
import { syncBlackouts } from "../jobs/blackouts";
import { drainOutbox } from "../jobs/outbox";
import { background } from "./background";

const STATE_TTL = 600; // seconds a consent round-trip may take
const stateSecret = (adminSecret: string) => `${adminSecret}:oauth-state`;
const redirectUri = (siteUrl: string) => `${siteUrl}/admin/google/callback`;

/** Mounted from adminRoutes() AFTER its cookie middleware, so /admin/api/google/* is protected and /admin/google/callback is not (D25). */
export function registerGoogleAdmin(r: App): void {
  r.get("/admin/api/google/status", async (c) => {
    const { google } = c.get("services");
    const [state, conn, sync, box] = await Promise.all([
      loadState(c.env.DB), loadConnection(c.env.DB, c.env.ADMIN_SECRET), loadSync(c.env.DB), counts(c.env.DB),
    ]);
    const connected = state !== null && conn !== null;
    return c.json({
      configured: google.configured(),
      connected,
      account: connected ? state.account : null,
      calendars: connected ? { closed: state.closedCalendarId, orders: state.ordersCalendarId } : null,
      connectedAt: connected ? state.connectedAt : null,
      lastSyncAt: sync.at,
      lastSyncError: sync.error,
      outbox: box,
    });
  });

  r.get("/admin/api/google/start", async (c) => {
    const { google, clock } = c.get("services");
    if (!google.configured()) return c.json({ error: "google_not_configured" }, 503);
    const nowSec = Math.floor(clock().getTime() / 1000);
    const state = await makeSession(stateSecret(c.env.ADMIN_SECRET), nowSec, STATE_TTL);
    return c.redirect(google.authUrl(state, redirectUri(c.env.SITE_URL)), 302);
  });

  r.get("/admin/google/callback", async (c) => {
    const { google, clock, config } = c.get("services");
    const nowSec = Math.floor(clock().getTime() / 1000);
    const state = c.req.query("state");
    if (!(await verifySession(state, stateSecret(c.env.ADMIN_SECRET), nowSec))) return c.text("bad or expired state", 400);
    if (c.req.query("error")) return c.redirect("/admin/?google=denied", 302);
    const code = c.req.query("code");
    if (!code) return c.text("missing code", 400);
    try {
      const conn = await google.exchangeCode(code, redirectUri(c.env.SITE_URL));
      await saveConnection(c.env.DB, c.env.ADMIN_SECRET, conn);
      const closedCalendarId = await google.ensureCalendar(config.calendars.closed, config.timezone);
      const ordersCalendarId = await google.ensureCalendar(config.calendars.orders, config.timezone);
      await saveState(c.env.DB, { account: conn.account, closedCalendarId, ordersCalendarId, connectedAt: nowSec });
      // Anything queued while disconnected goes out now rather than on the next 15-minute cron
      // (found on the 2026-09-10 road test: a reconnect left three messages waiting with no way to send them).
      await background(c, drainOutbox({ db: c.env.DB, google, config, siteUrl: c.env.SITE_URL }, clock()));
      return c.redirect("/admin/?google=connected", 302);
    } catch (e) {
      console.error("google: connect failed", e);
      await clearConnection(c.env.DB);
      return c.redirect("/admin/?google=failed", 302);
    }
  });

  r.post("/admin/api/google/disconnect", async (c) => {
    await clearConnection(c.env.DB);
    await c.env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
    return c.body(null, 204);
  });

  r.post("/admin/api/google/sync", async (c) => {
    const { google, clock, config } = c.get("services");
    return c.json(await syncBlackouts(c.env.DB, google, config.timezone, clock()));
  });

  r.post("/admin/api/google/retry", async (c) => {
    const { google, clock, config } = c.get("services");
    const now = clock();
    const retried = await retryFailed(c.env.DB, Math.floor(now.getTime() / 1000));
    const drain = await drainOutbox({ db: c.env.DB, google, config, siteUrl: c.env.SITE_URL }, now);
    return c.json({ retried, drain });
  });
}
