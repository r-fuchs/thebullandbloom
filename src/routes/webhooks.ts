import { Hono } from "hono";
import type { App } from "../app";
import { markPaidBySession, cancelHeldBySession } from "../store/orders";
import { enqueueForSessionStatements, enqueueForSubjectStatements, ORDER_PAID_KINDS, SUB_CANCELLED_KINDS, SUB_CONFIRMED_KINDS } from "../store/outbox";
import { byStripeSubscription, deleteFutureMaterialized, insertSubscriber, setSubscriberStatus, type SubscriberStatus } from "../store/subscribers";
import { drainOutbox } from "../jobs/outbox";
import { anchorFor, materializeSubscriptions } from "../jobs/materialize";
import { subscriptionCell } from "../config";
import { ymdIn } from "../core/time";
import { background } from "./background";

/** Stripe subscription status → ours (D28). Paused collection or an unpaid invoice both stop bouquets. */
export function mirrorStatus(status: string, paused: boolean): SubscriberStatus | null {
  if (status === "canceled" || status === "incomplete_expired") return "cancelled";
  if (paused || status === "past_due" || status === "unpaid" || status === "paused") return "paused";
  if (status === "active" || status === "trialing") return "active";
  return null; // incomplete: wait for the next event
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
    const now = clock();
    const nowSec = Math.floor(now.getTime() / 1000);
    const outboxDeps = { db: c.env.DB, google, payments, config, siteUrl: c.env.SITE_URL };

    if (event.type === "checkout.session.completed") {
      const order = await markPaidBySession(
        c.env.DB, event.sessionId, event.paymentIntent,
        enqueueForSessionStatements(c.env.DB, event.sessionId, ORDER_PAID_KINDS, nowSec),
      );
      if (!order) console.error("webhook: completed but no held order for session", event.sessionId);
      else await background(c, drainOutbox(outboxDeps, now));
      return c.json({ received: true, applied: order ? "paid" : "ignored" });
    }
    if (event.type === "checkout.session.expired") {
      const did = await cancelHeldBySession(c.env.DB, event.sessionId);
      return c.json({ received: true, applied: did ? "cancelled" : "ignored" });
    }

    if (event.type === "subscription.started") {
      const m = event.metadata;
      const [sizeId = "", cadenceId = ""] = (m.cell ?? "").split("/");
      const weekday = Number(m.weekday);
      if (!subscriptionCell(config, sizeId, cadenceId) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !event.subscriptionId || !event.customerId) {
        console.error("webhook: subscription.started with unusable metadata", event.sessionId, m);
        return c.json({ received: true, applied: "ignored" });
      }
      const anchorDate = await anchorFor({ db: c.env.DB, config }, weekday, now);
      const id = crypto.randomUUID();
      const inserted = await insertSubscriber(c.env.DB, {
        id, stripeCustomerId: event.customerId, stripeSubscriptionId: event.subscriptionId,
        sizeId, cadenceId, weekday, fulfillment: "pickup", addressJson: null, deliveryAddOnCents: 0, anchorDate,
        customerName: (m.name ?? "").trim() || event.customerEmail, customerEmail: event.customerEmail,
        customerPhone: (m.phone ?? "").trim() || null, note: (m.note ?? "").trim() || null,
      }, nowSec);
      if (!inserted) return c.json({ received: true, applied: "ignored" });
      await c.env.DB.batch(enqueueForSubjectStatements(c.env.DB, id, SUB_CONFIRMED_KINDS, nowSec));
      await materializeSubscriptions({ db: c.env.DB, config }, now, id);
      await background(c, drainOutbox(outboxDeps, now));
      return c.json({ received: true, applied: "subscribed" });
    }

    if (event.type === "subscription.updated" || event.type === "subscription.deleted") {
      const sub = await byStripeSubscription(c.env.DB, event.subscriptionId);
      if (!sub) { console.error("webhook: unknown subscription", event.subscriptionId); return c.json({ received: true, applied: "ignored" }); }
      const next = event.type === "subscription.deleted" ? "cancelled" : mirrorStatus(event.status, event.paused);
      if (!next || next === sub.status) return c.json({ received: true, applied: "ignored" });
      await setSubscriberStatus(c.env.DB, sub.id, next);
      const today = ymdIn(config.timezone, now);
      if (next === "cancelled") {
        // This week's bouquet, if already on the calendar, stays (email copy promises it); later ones go.
        await deleteFutureMaterialized(c.env.DB, sub.id, endOfWeek(today));
        await c.env.DB.batch(enqueueForSubjectStatements(c.env.DB, sub.id, SUB_CANCELLED_KINDS, nowSec));
        await background(c, drainOutbox(outboxDeps, now));
      } else if (next === "paused") {
        await deleteFutureMaterialized(c.env.DB, sub.id, today);
      } else {
        await materializeSubscriptions({ db: c.env.DB, config }, now, sub.id);
        await background(c, drainOutbox(outboxDeps, now));
      }
      return c.json({ received: true, applied: next });
    }
    return c.json({ received: true, applied: "ignored" });
  });
  return r;
}

/** Sunday of the Mon–Sun week holding `ymd`. */
function endOfWeek(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const wd = t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + (wd === 0 ? 0 : 7 - wd));
  return t.toISOString().slice(0, 10);
}
