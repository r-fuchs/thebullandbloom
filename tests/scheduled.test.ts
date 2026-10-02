import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { runScheduled } from "../src/scheduled";
import { clearConnection, saveState } from "../src/store/google";
import { testServices } from "./helpers";

const ORDER = `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, hold_expires_at)
  VALUES (?, 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'A', 'a@example.com', 8500, ?)`;

describe("runScheduled", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM bookings").run();
    await env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
  });

  it("expires stale holds and reports the Google jobs as skipped when not connected", async () => {
    const now = 1_800_000_000;
    await env.DB.batch([env.DB.prepare(ORDER).bind("s1", now - 1), env.DB.prepare(ORDER).bind("s2", now + 600)]);
    await env.DB.prepare(`INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, price_cents, hold_expires_at)
      VALUES ('sb1', 1, 'held', 'wreath-test', 'sat', 'A', 'a@example.com', 8500, ?), ('sb2', 1, 'held', 'wreath-test', 'sat', 'B', 'b@example.com', 8500, ?)`)
      .bind(now - 1, now + 600).run();
    const { services } = testServices();
    expect(await runScheduled(env, services, new Date(now * 1000))).toEqual({
      expiredHolds: 1,
      expiredBookingHolds: 1,
      blackouts: { status: "skipped" },
      subscriptions: { status: "ok", created: 0, skippedWeeks: 0 },
      instagram: { status: "skipped" },
      outbox: { status: "ok", delivered: 0, failed: 0, waiting: 0 },
      watchdog: { stuck: 0, givenUp: 0, oldestAgeSec: null, alerted: false, recovered: false },
    });
    const s = await env.DB.prepare("SELECT id, status FROM orders WHERE id IN ('s1','s2') ORDER BY id").all<any>();
    expect(s.results).toEqual([{ id: "s1", status: "cancelled" }, { id: "s2", status: "held" }]);
    const b = await env.DB.prepare("SELECT id, status FROM bookings WHERE id IN ('sb1','sb2') ORDER BY id").all<any>();
    expect(b.results).toEqual([{ id: "sb1", status: "cancelled" }, { id: "sb2", status: "held" }]);
  });

  it("runs blackout sync and outbox drain when connected, isolating a failure", async () => {
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 });
    const { services, google } = testServices();
    google.events["cal_closed"] = [{ id: "v", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } }];
    google.failNext = "listEvents exploded";
    const r = await runScheduled(env, services, new Date("2026-09-08T14:00:00Z"));
    expect(r.expiredHolds).toBe(0);
    expect(r.expiredBookingHolds).toBe(0);
    expect(r.blackouts).toEqual({ status: "error", error: "listEvents exploded" });
    expect(r.outbox).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
    const r2 = await runScheduled(env, services, new Date("2026-09-08T14:15:00Z"));
    expect(r2.blackouts).toEqual({ status: "ok", added: 1, removed: 0, closed: 1 });
  });

  it("runs the watchdog after the drain: a given-up row alerts, and the report says so", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'watchdog.state'").run();
    await env.DB.prepare("INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at) VALUES ('wd1', 'email_owner', 'nope', 1, 24, NULL)").run();
    const { services, alerts } = testServices();
    const r = await runScheduled(env, services, new Date("2026-09-08T14:00:00Z"));
    expect(r.watchdog).toMatchObject({ stuck: 1, givenUp: 1, alerted: true, recovered: false });
    expect(alerts.sent).toHaveLength(1);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'watchdog.state'").run();
  });
});
