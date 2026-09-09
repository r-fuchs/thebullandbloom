import { Hono } from "hono";
import type { App } from "../app";
import { markPaidBySession, cancelHeldBySession, markDoneIfPaid } from "../store/orders";
import { enqueueForSessionStatements, ORDER_PAID_KINDS } from "../store/outbox";
import { drainOutbox } from "../jobs/outbox";
import { background } from "./background";
import { verifyUberSignature } from "../adapters/uber";
import { applyStatus, type DeliveryStatus } from "../store/deliveries";

const DELIVERY_STATUSES: readonly DeliveryStatus[] =
  ["pending", "pickup", "pickup_complete", "dropoff", "delivered", "canceled", "returned"];

/** Only statuses we model; anything else (a new Uber value, a typo) is acknowledged and dropped. */
function knownStatus(v: unknown): DeliveryStatus | null {
  return typeof v === "string" && (DELIVERY_STATUSES as readonly string[]).includes(v) ? (v as DeliveryStatus) : null;
}

export function webhookRoutes(): App {
  const r: App = new Hono();
  r.post("/webhooks/stripe", async (c) => {
    const { payments, google, config, clock } = c.get("services");
    const sig = c.req.header("stripe-signature");
    if (!sig) {
      console.error("webhook: bad signature");
      return c.json({ error: "missing signature" }, 400);
    }
    let event;
    try { event = await payments.parseWebhook(await c.req.text(), sig); }
    catch {
      console.error("webhook: bad signature");
      return c.json({ error: "bad signature" }, 400);
    }

    if (event.type === "checkout.session.completed") {
      const nowSec = Math.floor(clock().getTime() / 1000);
      const order = await markPaidBySession(
        c.env.DB, event.sessionId, event.paymentIntent,
        enqueueForSessionStatements(c.env.DB, event.sessionId, ORDER_PAID_KINDS, nowSec),
      );
      if (!order) console.error("webhook: completed but no held order for session", event.sessionId);
      else await background(c, drainOutbox({ db: c.env.DB, google, config, siteUrl: c.env.SITE_URL }, clock()));
      return c.json({ received: true, applied: order ? "paid" : "ignored" });
    }
    if (event.type === "checkout.session.expired") {
      const did = await cancelHeldBySession(c.env.DB, event.sessionId);
      return c.json({ received: true, applied: did ? "cancelled" : "ignored" });
    }
    return c.json({ received: true, applied: "ignored" });
  });

  r.post("/webhooks/uber", async (c) => {
    const { clock } = c.get("services");
    const secret = c.env.UBER_WEBHOOK_SECRET;
    const raw = await c.req.text();
    // Both headers are accepted: `x-uber-signature` is current, `x-postmates-signature` is the
    // legacy alias Uber still sends on delivery-status events (verified 2026-09-09).
    const sig = c.req.header("x-uber-signature") ?? c.req.header("x-postmates-signature");
    if (!secret || !(await verifyUberSignature(secret ?? "", raw, sig))) {
      console.error("webhook: bad uber signature");
      return c.json({ error: "bad signature" }, 400);
    }

    let event: any;
    try { event = JSON.parse(raw); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (event?.kind !== "event.delivery_status") return c.json({ received: true, applied: "ignored" });

    const deliveryId = typeof event.delivery_id === "string" ? event.delivery_id
      : typeof event?.data?.id === "string" ? event.data.id : "";
    const status = knownStatus(event.status ?? event?.data?.status);
    if (!deliveryId || !status) return c.json({ received: true, applied: "ignored" });

    const nowSec = Math.floor(clock().getTime() / 1000);
    const reason = typeof event?.data?.undeliverable_reason === "string" ? event.data.undeliverable_reason : null;
    const delivery = await applyStatus(c.env.DB, deliveryId, status, reason, nowSec);
    if (!delivery) {
      // A delivery from another environment, or one whose row we lost. Acknowledge so Uber stops retrying.
      console.error("webhook: uber status for a delivery we do not have", deliveryId, status);
      return c.json({ received: true, applied: "unknown" });
    }
    if (status === "delivered") await markDoneIfPaid(c.env.DB, delivery.orderId);
    return c.json({ received: true, applied: status });
  });

  return r;
}
