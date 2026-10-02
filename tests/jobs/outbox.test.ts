import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { drainOutbox } from "../../src/jobs/outbox";
import { BOOKING_PAID_KINDS, ORDER_PAID_KINDS, counts, enqueueCourierEmailStatement, enqueueForBookingSessionStatements, enqueueForSessionStatements } from "../../src/store/outbox";
import { clearConnection, saveState } from "../../src/store/google";
import { loadConfig } from "../../src/config";
import { FakeGoogle } from "../fakes/google";
import { FakeMailer } from "../fakes/mailer";
import { FakeAlerts } from "../fakes/alerts";
import { RecordingPayments, WREATH, offersConfig } from "../helpers";
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
async function paidBooking(id: string, session: string, sessionId = "sat", offerId = WREATH.id) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note, price_cents, stripe_session_id)
     VALUES (?, 1, 'paid', ?, ?, 'Jane Doe', 'jane@example.com', '518-555-0100', 'first wreath', 8500, ?)`,
  ).bind(id, offerId, sessionId, session).run();
  await env.DB.batch(enqueueForBookingSessionStatements(env.DB, session, BOOKING_PAID_KINDS, NOW_SEC));
}
let m: FakeMailer;
let al: FakeAlerts;
const deps = (google: FakeGoogle, config = cfg) => ({ db: env.DB, google, mailer: m, alerts: al, payments: new RecordingPayments(), config, siteUrl: "https://x.test" });

describe("drainOutbox", () => {
  beforeEach(async () => {
    m = new FakeMailer();
    al = new FakeAlerts();
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM bookings").run();
  });

  it("delivers mail while Google is disconnected; calendar rows wait untouched", async () => {
    await paidOrder("d1", "cs_d1");
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 2, failed: 0, waiting: 1 });
    expect(m.sent).toHaveLength(2);
    expect(g.inserted).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 1, failed: 0 });
    const row = await env.DB.prepare("SELECT attempts FROM outbox WHERE order_id = 'd1' AND kind = 'calendar_event'").first<any>();
    expect(row.attempts).toBe(0);
  });

  it("delivers the calendar row once Google is connected", async () => {
    await paidOrder("d1b", "cs_d1b");
    const g = new FakeGoogle();
    await drainOutbox(deps(g), NOW);
    await saveState(env.DB, STATE);
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 1, failed: 0, waiting: 0 });
    expect(g.inserted).toHaveLength(1);
    expect(m.sent).toHaveLength(2);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
  });

  it("leaves mail rows waiting with no attempt counted when the mailer is not configured", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d1c", "cs_d1c");
    m.isConfigured = false;
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 1, failed: 0, waiting: 2 });
    expect(m.sent).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    const rows = await env.DB.prepare("SELECT attempts, next_attempt_at FROM outbox WHERE order_id = 'd1c' AND done_at IS NULL").all<any>();
    expect(rows.results.map((r) => r.attempts)).toEqual([0, 0]);
    m.isConfigured = true;
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 2, failed: 0, waiting: 0 });
  });

  it("an owner email failure raises an alert and still retries (D58); a customer email failure does not alert", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d1d", "cs_d1d");
    await env.DB.prepare("DELETE FROM outbox WHERE order_id = 'd1d' AND kind != 'email_owner'").run();
    const g = new FakeGoogle();
    m.failNext = "resend 503: down";
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 1, waiting: 0 });
    expect(al.sent).toHaveLength(1);
    expect(al.sent[0].subject).toMatch(/^New order: .*Pat Smith/);
    expect(al.sent[0].text.length).toBeGreaterThan(0);
    const row = await env.DB.prepare("SELECT attempts, last_error FROM outbox WHERE order_id = 'd1d'").first<any>();
    expect(row).toEqual({ attempts: 1, last_error: "resend 503: down" });

    // a retry that fails again does not alert a second time
    m.failNext = "resend 503: still down";
    expect(await drainOutbox(deps(g), new Date(NOW.getTime() + 200_000))).toEqual({ status: "ok", delivered: 0, failed: 1, waiting: 0 });
    expect(al.sent).toHaveLength(1);
    expect((await env.DB.prepare("SELECT attempts FROM outbox WHERE order_id = 'd1d'").first<any>()).attempts).toBe(2);

    await paidOrder("d1e", "cs_d1e");
    await env.DB.prepare("DELETE FROM outbox WHERE order_id = 'd1e' AND kind != 'email_customer'").run();
    m.failNext = "resend 503: down";
    await drainOutbox(deps(g), NOW);
    expect(al.sent).toHaveLength(1);
  });

  it("creates the calendar event, stores its id, and sends both emails", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d2", "cs_d2");
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 3, failed: 0, waiting: 0 });
    expect(g.inserted).toHaveLength(1);
    expect(g.inserted[0].calendarId).toBe("cal_orders");
    expect(g.inserted[0].event.summary).toBe("Bouquet · Pat Smith · pickup");
    expect(g.inserted[0].event.date).toBe("2026-09-09");
    const o = await env.DB.prepare("SELECT calendar_event_id FROM orders WHERE id = 'd2'").first<any>();
    expect(o.calendar_event_id).toBe("bbd2");
    expect(m.sent.map((m) => m.to).sort()).toEqual(["pat@example.com", cfg.studio.ownerEmail].sort());
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    // second drain: nothing due, nothing sent again
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
    expect(m.sent).toHaveLength(2);
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
    expect(r).toEqual({ status: "ok", delivered: 2, failed: 1, waiting: 0 });
    const failed = await env.DB.prepare("SELECT kind, attempts, next_attempt_at, last_error FROM outbox WHERE order_id = 'd4' AND done_at IS NULL").first<any>();
    expect(failed).toEqual({ kind: "calendar_event", attempts: 1, next_attempt_at: NOW_SEC + 120, last_error: "gmail 500" });
    expect(await drainOutbox(deps(g), new Date((NOW_SEC + 60) * 1000))).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
    expect(await drainOutbox(deps(g), new Date((NOW_SEC + 120) * 1000))).toEqual({ status: "ok", delivered: 1, failed: 0, waiting: 0 });
    expect(g.inserted).toHaveLength(1);
  });

  it("gives up after the 24th failed attempt", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d5", "cs_d5");
    await env.DB.prepare("UPDATE outbox SET attempts = 23 WHERE order_id = 'd5' AND kind = 'email_owner'").run();
    await env.DB.prepare("DELETE FROM outbox WHERE order_id = 'd5' AND kind != 'email_owner'").run();
    const g = new FakeGoogle();
    m.failNext = "still down";
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 1, waiting: 0 });
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 1 });
  });

  it("marks items done without sending when the order is no longer paid or done", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d6", "cs_d6");
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = 'd6'").run();
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
    expect(m.sent).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
  });

  it("never double-sends when two drains race over the same paid order (webhook + cron, or two near-simultaneous checkouts)", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d7", "cs_d7");
    const g = new FakeGoogle();
    const [r1, r2] = await Promise.all([drainOutbox(deps(g), NOW), drainOutbox(deps(g), NOW)]);
    expect(g.inserted).toHaveLength(1);
    expect(m.sent).toHaveLength(2);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    expect(r1.delivered + r2.delivered).toBe(3);
  });

  it("leaves rows of a kind this build does not know untouched", async () => {
    await saveState(env.DB, STATE);
    await env.DB.prepare("INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at) VALUES ('u1', 'email_tracking', 'someorder', 1, 0, 1)").run();
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
    const row = await env.DB.prepare("SELECT attempts, next_attempt_at, done_at FROM outbox WHERE id = 'u1'").first<any>();
    expect(row).toEqual({ attempts: 0, next_attempt_at: 1, done_at: null });
    expect(m.sent).toHaveLength(0);
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
      expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 1, failed: 0, waiting: 0 });
      expect(m.sent[0].to).toBe("pat@example.com");
      expect(m.sent[0].text).toContain("https://direct.uber.com/track/u_cd1");
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
      expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
      expect(m.sent).toHaveLength(0);
      expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    });

    it("retries with backoff when the mail provider is down, exactly like the other kinds", async () => {
      await saveState(env.DB, STATE);
      await paidDeliveryOrder("cd3", "cs_cd3");
      await insertDelivery(env.DB, {
        id: "del-row-3", orderId: "cd3", uberDeliveryId: "u_cd3", status: "pending",
        quotedCents: 1400, feeCents: 1400, trackingUrl: "https://t.test/3", at: NOW_SEC,
      });
      await env.DB.batch([enqueueCourierEmailStatement(env.DB, "cd3", NOW_SEC)]);
      const g = new FakeGoogle();
      m.failNext = "gmail down";
      expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 1, waiting: 0 });
      const row = await env.DB.prepare("SELECT attempts, last_error FROM outbox WHERE order_id = 'cd3'").first<any>();
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe("gmail down");
    });
  });

  describe("booking emails (Plan 7)", () => {
    it("sends the customer confirmation and Anthony's headcount email", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk1", "cs_bk1");
      await env.DB.prepare(`INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, price_cents)
        VALUES ('bk1b', 1, 'held', ?, 'sat', 'B', 'b@example.com', 8500)`).bind(WREATH.id).run();
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 2, failed: 0, waiting: 0 });
      const customer = m.sent.find((m) => m.to === "jane@example.com")!;
      expect(customer.subject).toBe("Your seat at Wreath & Sip");
      expect(customer.text).toContain("Refreshments will be provided.");
      expect(customer.text).toContain(cfg.studio.address.street);
      const owner = m.sent.find((m) => m.to === cfg.studio.ownerEmail)!;
      expect(owner.subject).toBe("Jane Doe booked Wreath & Sip, Sat Sep 12 · 2 of 2 seats");
      expect(owner.text).toContain("518-555-0100");
      expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
      expect(m.sent).toHaveLength(2);
    });
    it("drops both emails when the booking is no longer paid", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk2", "cs_bk2");
      await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = 'bk2'").run();
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 0 });
      expect(m.sent).toHaveLength(0);
      expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    });
    it("keeps retrying when the session has been removed from config, so the loss is visible", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk3", "cs_bk3", "gone");
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 0, failed: 2, waiting: 0 });
      const row = await env.DB.prepare("SELECT last_error FROM outbox WHERE order_id = 'bk3' LIMIT 1").first<any>();
      expect(row.last_error).toContain("gone");
      expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    });
    it("retries with backoff when the mail provider is down", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk4", "cs_bk4");
      const g = new FakeGoogle();
      m.failNext = "gmail down";
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 1, failed: 1, waiting: 0 });
      expect(await drainOutbox(deps(g, offersConfig()), new Date((NOW_SEC + 120) * 1000))).toEqual({ status: "ok", delivered: 1, failed: 0, waiting: 0 });
      expect(m.sent).toHaveLength(2);
    });
  });
});
