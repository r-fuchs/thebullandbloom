import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { drainOutbox } from "../../src/jobs/outbox";
import { ORDER_PAID_KINDS, counts, enqueueCourierEmailStatement, enqueueForSessionStatements } from "../../src/store/outbox";
import { clearConnection, saveState } from "../../src/store/google";
import { loadConfig } from "../../src/config";
import { FakeGoogle } from "../fakes/google";
import { RecordingPayments } from "../helpers";
import { insertDelivery, applyStatus } from "../../src/store/deliveries";

const NOW = new Date("2026-09-08T14:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const STATE = { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 };
const cfg = loadConfig();

async function paidOrder(id: string, session: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, customer_phone, note, bouquet_cents, stripe_session_id)
     VALUES (?, 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'Pat Smith', 'pat@example.com', NULL, NULL, 8500, ?)`,
  ).bind(id, session).run();
  await env.DB.batch(enqueueForSessionStatements(env.DB, session, ORDER_PAID_KINDS, NOW_SEC));
}
async function paidDeliveryOrder(id: string, session: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, note, bouquet_cents, delivery_cents, stripe_session_id)
     VALUES (?, 1, 'paid', '2026-09-23', 'bouquet', 'delivery', 'Pat Smith', 'pat@example.com', '+15185550100',
       '{"street":"5 Elm Street","unit":"","city":"Hudson","state":"NY","zip":"12534","notes":"porch"}', NULL, 8500, 1350, ?)`,
  ).bind(id, session).run();
}
const deps = (google: FakeGoogle) => ({ db: env.DB, google, payments: new RecordingPayments(), config: cfg, siteUrl: "https://x.test" });

describe("drainOutbox", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM deliveries").run();
  });

  it("skips without touching rows when Google is not connected", async () => {
    await paidOrder("d1", "cs_d1");
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "skipped", delivered: 0, failed: 0 });
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
    const row = await env.DB.prepare("SELECT attempts FROM outbox WHERE order_id = 'd1' LIMIT 1").first<any>();
    expect(row.attempts).toBe(0);
  });

  it("creates the calendar event, stores its id, and sends both emails", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d2", "cs_d2");
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 3, failed: 0 });
    expect(g.inserted).toHaveLength(1);
    expect(g.inserted[0].calendarId).toBe("cal_orders");
    expect(g.inserted[0].event.summary).toBe("Bouquet · Pat Smith · pickup");
    expect(g.inserted[0].event.date).toBe("2026-09-09");
    const o = await env.DB.prepare("SELECT calendar_event_id FROM orders WHERE id = 'd2'").first<any>();
    expect(o.calendar_event_id).toBe("bbd2");
    expect(g.sent.map((m) => m.to).sort()).toEqual(["pat@example.com", cfg.studio.ownerEmail].sort());
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    // second drain: nothing due, nothing sent again
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
    expect(g.sent).toHaveLength(2);
  });

  it("does not insert a second event when the order already has one", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d3", "cs_d3");
    await env.DB.prepare("UPDATE orders SET calendar_event_id = 'already' WHERE id = 'd3'").run();
    const g = new FakeGoogle();
    await drainOutbox(deps(g), NOW);
    expect(g.inserted).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
  });

  it("records a failure with backoff and retries later", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d4", "cs_d4");
    const g = new FakeGoogle();
    g.failNext = "gmail 500";
    const r = await drainOutbox(deps(g), NOW);
    expect(r).toEqual({ status: "ok", delivered: 2, failed: 1 });
    const failed = await env.DB.prepare("SELECT kind, attempts, next_attempt_at, last_error FROM outbox WHERE order_id = 'd4' AND done_at IS NULL").first<any>();
    expect(failed).toEqual({ kind: "calendar_event", attempts: 1, next_attempt_at: NOW_SEC + 120, last_error: "gmail 500" });
    expect(await drainOutbox(deps(g), new Date((NOW_SEC + 60) * 1000))).toEqual({ status: "ok", delivered: 0, failed: 0 });
    expect(await drainOutbox(deps(g), new Date((NOW_SEC + 120) * 1000))).toEqual({ status: "ok", delivered: 1, failed: 0 });
    expect(g.inserted).toHaveLength(1);
  });

  it("gives up after the 24th failed attempt", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d5", "cs_d5");
    await env.DB.prepare("UPDATE outbox SET attempts = 23 WHERE order_id = 'd5' AND kind = 'email_owner'").run();
    await env.DB.prepare("DELETE FROM outbox WHERE order_id = 'd5' AND kind != 'email_owner'").run();
    const g = new FakeGoogle();
    g.failNext = "still down";
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 1 });
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 1 });
  });

  it("marks items done without sending when the order is no longer paid or done", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d6", "cs_d6");
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = 'd6'").run();
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
    expect(g.sent).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
  });

  it("never double-sends when two drains race over the same paid order (webhook + cron, or two near-simultaneous checkouts)", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d7", "cs_d7");
    const g = new FakeGoogle();
    const [r1, r2] = await Promise.all([drainOutbox(deps(g), NOW), drainOutbox(deps(g), NOW)]);
    expect(g.inserted).toHaveLength(1);
    expect(g.sent).toHaveLength(2);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    expect(r1.delivered + r2.delivered).toBe(3);
  });

  it("leaves rows of a kind this build does not know untouched", async () => {
    await saveState(env.DB, STATE);
    await env.DB.prepare("INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at) VALUES ('u1', 'email_tracking', 'someorder', 1, 0, 1)").run();
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
    const row = await env.DB.prepare("SELECT attempts, next_attempt_at, done_at FROM outbox WHERE id = 'u1'").first<any>();
    expect(row).toEqual({ attempts: 0, next_attempt_at: 1, done_at: null });
    expect(g.sent).toHaveLength(0);
  });

  describe("courier email", () => {
    it("sends the tracking link for the order's live delivery", async () => {
      await saveState(env.DB, STATE);
      await paidDeliveryOrder("cd1", "cs_cd1");
      await insertDelivery(env.DB, {
        id: "del-row-1", orderId: "cd1", uberDeliveryId: "u_cd1", status: "pending",
        quotedCents: 1400, feeCents: 1400, trackingUrl: "https://direct.uber.com/track/u_cd1", at: NOW_SEC,
      });
      await env.DB.batch([enqueueCourierEmailStatement(env.DB, "cd1", NOW_SEC)]);
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 1, failed: 0 });
      expect(g.sent[0].to).toBe("pat@example.com");
      expect(g.sent[0].text).toContain("https://direct.uber.com/track/u_cd1");
    });

    it("drops the courier email when the delivery has since been canceled", async () => {
      await saveState(env.DB, STATE);
      await paidDeliveryOrder("cd2", "cs_cd2");
      await insertDelivery(env.DB, {
        id: "del-row-2", orderId: "cd2", uberDeliveryId: "u_cd2", status: "pending",
        quotedCents: 1400, feeCents: 1400, trackingUrl: "https://t.test/2", at: NOW_SEC,
      });
      await applyStatus(env.DB, "u_cd2", "canceled", "studio cancelled", NOW_SEC);
      await env.DB.batch([enqueueCourierEmailStatement(env.DB, "cd2", NOW_SEC)]);
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
      expect(g.sent).toHaveLength(0);
      expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    });

    it("retries with backoff when Gmail is down, exactly like the other kinds", async () => {
      await saveState(env.DB, STATE);
      await paidDeliveryOrder("cd3", "cs_cd3");
      await insertDelivery(env.DB, {
        id: "del-row-3", orderId: "cd3", uberDeliveryId: "u_cd3", status: "pending",
        quotedCents: 1400, feeCents: 1400, trackingUrl: "https://t.test/3", at: NOW_SEC,
      });
      await env.DB.batch([enqueueCourierEmailStatement(env.DB, "cd3", NOW_SEC)]);
      const g = new FakeGoogle();
      g.failNext = "gmail down";
      expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 1 });
      const row = await env.DB.prepare("SELECT attempts, last_error FROM outbox WHERE order_id = 'cd3'").first<any>();
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe("gmail down");
    });
  });
});
