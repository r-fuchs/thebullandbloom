import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp } from "../helpers";
import { saveState, clearConnection } from "../../src/store/google";
import { counts } from "../../src/store/outbox";
import { insertDelivery } from "../../src/store/deliveries";

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

/** Sign a body exactly as Uber does: HMAC-SHA256 of the raw body, lowercase hex. */
async function uberSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uberHook(fetch: any, payload: unknown, opts: { header?: string; signature?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = opts.signature ?? await uberSign("test-webhook-secret", body);
  const header = opts.header ?? "x-uber-signature";
  return fetch("/webhooks/uber", { method: "POST", headers: { [header]: sig, "content-type": "application/json" }, body });
}

async function deliveryOrder(id: string, uberId: string, status = "paid") {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, bouquet_cents, delivery_cents)
     VALUES (?, 1, ?, '2026-09-23', 'bouquet', 'delivery', 'Pat', 'pat@example.com', '+15185550100',
       '{"street":"5 Elm St","unit":"","city":"Hudson","state":"NY","zip":"12534","notes":""}', 8500, 1200)`,
  ).bind(id, status).run();
  await insertDelivery(env.DB, {
    id: `row_${uberId}`, orderId: id, uberDeliveryId: uberId, status: "pending",
    quotedCents: 1200, feeCents: 1250, trackingUrl: `https://t.test/${uberId}`, at: 100,
  });
}

const statusEvent = (deliveryId: string, status: string, extra: Record<string, unknown> = {}) => ({
  kind: "event.delivery_status", delivery_id: deliveryId, status,
  created: "2026-09-23T15:20:00Z", customer_id: "cus_test", live_mode: true,
  data: { id: deliveryId, status, ...extra },
});

describe("POST /webhooks/uber", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
  });

  it("moves the delivery through its statuses and is idempotent", async () => {
    await deliveryOrder("u1", "del_1");
    const { fetch } = testApp(new Date("2026-09-23T15:30:00Z"));
    for (const s of ["pickup", "pickup_complete", "dropoff"]) {
      const r = await uberHook(fetch, statusEvent("del_1", s));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ received: true, applied: s });
    }
    await uberHook(fetch, statusEvent("del_1", "dropoff"));
    const rows = await env.DB.prepare("SELECT status, updated_at FROM deliveries WHERE uber_delivery_id = 'del_1'").all<any>();
    expect(rows.results).toEqual([{ status: "dropoff", updated_at: Math.floor(new Date("2026-09-23T15:30:00Z").getTime() / 1000) }]);
  });

  it("marks the order done when the bouquet is delivered, once", async () => {
    await deliveryOrder("u2", "del_2");
    const { fetch } = testApp();
    expect(await (await uberHook(fetch, statusEvent("del_2", "delivered"))).json()).toEqual({ received: true, applied: "delivered" });
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u2'").first<any>()).status).toBe("done");
    // a replay must not resurrect anything or throw
    expect((await uberHook(fetch, statusEvent("del_2", "delivered"))).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u2'").first<any>()).status).toBe("done");
  });

  it("never un-cancels an order that was refunded before the courier finished", async () => {
    await deliveryOrder("u3", "del_3", "refunded");
    const { fetch } = testApp();
    await uberHook(fetch, statusEvent("del_3", "delivered"));
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u3'").first<any>()).status).toBe("refunded");
  });

  it("records the reason on a canceled or returned delivery so admin can show it", async () => {
    await deliveryOrder("u4", "del_4");
    const { fetch } = testApp();
    await uberHook(fetch, statusEvent("del_4", "returned", { undeliverable_reason: "customer_unavailable" }));
    const row = await env.DB.prepare("SELECT status, last_error FROM deliveries WHERE uber_delivery_id = 'del_4'").first<any>();
    expect(row).toEqual({ status: "returned", last_error: "customer_unavailable" });
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u4'").first<any>()).status).toBe("paid");
  });

  it("keeps a returned delivery's reason when a late, reordered dropoff webhook arrives", async () => {
    await deliveryOrder("u4b", "del_4b");
    const { fetch } = testApp();
    const r1 = await uberHook(fetch, statusEvent("del_4b", "returned", { undeliverable_reason: "customer_unavailable" }));
    expect(r1.status).toBe(200);
    const r2 = await uberHook(fetch, statusEvent("del_4b", "dropoff"));
    expect(r2.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, last_error FROM deliveries WHERE uber_delivery_id = 'del_4b'").first<any>();
    expect(row).toEqual({ status: "returned", last_error: "customer_unavailable" });
  });

  it("accepts the legacy x-postmates-signature header", async () => {
    await deliveryOrder("u5", "del_5");
    const { fetch } = testApp();
    const r = await uberHook(fetch, statusEvent("del_5", "pickup"), { header: "x-postmates-signature" });
    expect(r.status).toBe(200);
  });

  it("rejects a wrong signature and a missing one", async () => {
    const { fetch } = testApp();
    expect((await uberHook(fetch, statusEvent("del_x", "pickup"), { signature: "deadbeef" })).status).toBe(400);
    const r = await fetch("/webhooks/uber", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
  });

  it("acknowledges a delivery it has never heard of, and other event kinds, without touching anything", async () => {
    const { fetch } = testApp();
    expect(await (await uberHook(fetch, statusEvent("del_unknown", "pickup"))).json()).toEqual({ received: true, applied: "unknown" });
    expect(await (await uberHook(fetch, { kind: "event.courier_update", delivery_id: "del_1", location: {} })).json())
      .toEqual({ received: true, applied: "ignored" });
    expect(await (await uberHook(fetch, { kind: "event.refund_request", delivery_id: "del_1" })).json())
      .toEqual({ received: true, applied: "ignored" });
  });

  it("ignores a status value it does not know rather than writing it", async () => {
    await deliveryOrder("u6", "del_6");
    const { fetch } = testApp();
    expect(await (await uberHook(fetch, statusEvent("del_6", "teleported"))).json()).toEqual({ received: true, applied: "ignored" });
    expect((await env.DB.prepare("SELECT status FROM deliveries WHERE uber_delivery_id = 'del_6'").first<any>()).status).toBe("pending");
  });
});
