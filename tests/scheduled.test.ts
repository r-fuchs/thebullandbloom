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
    await env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
  });

  it("expires stale holds and reports the Google jobs as skipped when not connected", async () => {
    const now = 1_800_000_000;
    await env.DB.batch([env.DB.prepare(ORDER).bind("s1", now - 1), env.DB.prepare(ORDER).bind("s2", now + 600)]);
    const { services } = testServices();
    expect(await runScheduled(env, services, new Date(now * 1000))).toEqual({
      expiredHolds: 1,
      blackouts: { status: "skipped" },
      subscriptions: { status: "ok", created: 0, skippedWeeks: 0 },
      outbox: { status: "skipped", delivered: 0, failed: 0 },
    });
    const s = await env.DB.prepare("SELECT id, status FROM orders WHERE id IN ('s1','s2') ORDER BY id").all<any>();
    expect(s.results).toEqual([{ id: "s1", status: "cancelled" }, { id: "s2", status: "held" }]);
  });

  it("runs blackout sync and outbox drain when connected, isolating a failure", async () => {
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 });
    const { services, google } = testServices();
    google.events["cal_closed"] = [{ id: "v", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } }];
    google.failNext = "listEvents exploded";
    const r = await runScheduled(env, services, new Date("2026-09-08T14:00:00Z"));
    expect(r.expiredHolds).toBe(0);
    expect(r.blackouts).toEqual({ status: "error", error: "listEvents exploded" });
    expect(r.outbox).toEqual({ status: "ok", delivered: 0, failed: 0 });
    const r2 = await runScheduled(env, services, new Date("2026-09-08T14:15:00Z"));
    expect(r2.blackouts).toEqual({ status: "ok", added: 1, removed: 0, closed: 1 });
  });
});
