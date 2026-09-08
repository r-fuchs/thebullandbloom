import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testApp } from "../helpers";

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
