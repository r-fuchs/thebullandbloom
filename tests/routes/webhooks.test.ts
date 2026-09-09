import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testApp } from "../helpers";
import { saveState, clearConnection } from "../../src/store/google";
import { counts } from "../../src/store/outbox";

async function heldOrder(id: string, session: string) {
  await env.DB.prepare(
    `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id, hold_expires_at)
     VALUES (?, 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, ?, 99)`,
  ).bind(id, session).run();
}
const hook = (fetch: any, sig = "good") =>
  fetch("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sig }, body: "{}" });

describe("POST /webhooks/stripe", () => {
  it("marks the order paid on completion and is idempotent", async () => {
    await heldOrder("w1", "cs_w1");
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_w1", paymentIntent: "pi_w1" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paid" });
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
    const row = await env.DB.prepare("SELECT status, stripe_payment_intent, hold_expires_at FROM orders WHERE id = 'w1'").first<any>();
    expect(row).toEqual({ status: "paid", stripe_payment_intent: "pi_w1", hold_expires_at: null });
  });
  it("resurrects a cancelled (expired-hold) order when completion arrives late, and is idempotent (D17)", async () => {
    await heldOrder("w1c", "cs_w1c");
    await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'w1c'").run();
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_w1c", paymentIntent: "pi_w1c" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paid" });
    const row = await env.DB.prepare("SELECT status, stripe_payment_intent, hold_expires_at FROM orders WHERE id = 'w1c'").first<any>();
    expect(row).toEqual({ status: "paid", stripe_payment_intent: "pi_w1c", hold_expires_at: null });
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
  });
  it("cancels a held order on expiry", async () => {
    await heldOrder("w2", "cs_w2");
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.expired", sessionId: "cs_w2" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "cancelled" });
  });
  it("rejects bad signatures and missing headers", async () => {
    const { fetch } = testApp();
    expect((await hook(fetch, "bad")).status).toBe(400);
    expect((await fetch("/webhooks/stripe", { method: "POST", body: "{}" })).status).toBe(400);
  });
  it("acknowledges unrelated events", async () => {
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "other" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
  });
});

describe("POST /webhooks/stripe → outbox", () => {
  it("enqueues three deliveries with the paid flip and delivers them when Google is connected", async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await heldOrder("w5", "cs_w5");
    const { fetch, payments, google } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_w5", paymentIntent: "pi_w5" };
    // not connected: rows wait, webhook still 200
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paid" });
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
    expect(google.sent).toHaveLength(0);
    // connect and let a duplicate webhook through: no new rows, no delivery from the duplicate path
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
  });
  it("delivers immediately when connected and keeps the webhook 200 when Google fails", async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    await heldOrder("w6", "cs_w6");
    const { fetch, payments, google } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_w6", paymentIntent: "pi_w6" };
    google.failNext = "calendar down";
    const r = await hook(fetch);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, applied: "paid" });
    expect(google.inserted).toHaveLength(0);
    expect(google.sent).toHaveLength(2);
    expect(await counts(env.DB)).toEqual({ pending: 1, failed: 0 });
    const row = await env.DB.prepare("SELECT status FROM orders WHERE id = 'w6'").first<any>();
    expect(row.status).toBe("paid");
  });
});
