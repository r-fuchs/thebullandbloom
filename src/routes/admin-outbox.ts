import type { App } from "../app";
import { drainOutbox } from "../jobs/outbox";
import { loadWatchdogState } from "../jobs/watchdog";
import { counts, retryFailed, stuckSummary } from "../store/outbox";

/** Issue #3. Mounted from adminRoutes() AFTER its Access middleware, so every route here needs an identity. */
export function registerOutboxAdmin(r: App): void {
  r.get("/admin/api/outbox", async (c) => {
    const { mailer, alerts, clock } = c.get("services");
    const now = Math.floor(clock().getTime() / 1000);
    const [box, sum, wd] = await Promise.all([counts(c.env.DB), stuckSummary(c.env.DB, now), loadWatchdogState(c.env.DB)]);
    return c.json({
      pending: box.pending, failed: box.failed, stuck: sum.stuck, oldestAgeSec: sum.oldestAgeSec,
      mail: { configured: mailer.configured() }, alerts: { configured: alerts.configured() }, lastAlertAt: wd.lastAlertAt,
    });
  });

  // Same as /google/retry (which stays): revive given-up rows, then drain once.
  r.post("/admin/api/outbox/retry", async (c) => {
    const { google, mailer, alerts, payments, clock, config } = c.get("services");
    const now = clock();
    const retried = await retryFailed(c.env.DB, Math.floor(now.getTime() / 1000));
    const drain = await drainOutbox({ db: c.env.DB, google, mailer, alerts, payments, config, siteUrl: c.env.SITE_URL }, now);
    return c.json({ retried, drain });
  });
}
