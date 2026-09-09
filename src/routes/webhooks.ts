import { Hono } from "hono";
import type { App } from "../app";
import { markPaidBySession, cancelHeldBySession } from "../store/orders";
import { enqueueForSessionStatements, ORDER_PAID_KINDS } from "../store/outbox";
import { drainOutbox } from "../jobs/outbox";
import { background } from "./background";

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
  return r;
}
