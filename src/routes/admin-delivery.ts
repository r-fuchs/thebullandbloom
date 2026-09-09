import type { App } from "../app";
import { UberError } from "../adapters/uber";
import { deliveryItemName, deliveryWindow, normalizePhone } from "../core/delivery";
import { deliveryAddressOf } from "../core/messages";
import { activeDeliveryFor, insertDeliveryStatement, knownStatus, latestDeliveryFor, varianceTotal } from "../store/deliveries";
import { enqueueCourierEmailStatement } from "../store/outbox";
import { getOrder } from "../store/orders";
import { sizeById } from "../config";
import { drainOutbox } from "../jobs/outbox";
import { background } from "./background";

/** Mounted from adminRoutes() AFTER its cookie middleware, so every route here needs a session. */
export function registerDeliveryAdmin(r: App): void {
  r.get("/admin/api/delivery/status", async (c) => {
    const { uber, config } = c.get("services");
    return c.json({
      configured: uber.configured(),
      fallbackFeeCents: config.delivery.fallbackFeeCents,
      fallbackZips: config.delivery.fallbackZips,
      variance: await varianceTotal(c.env.DB),
    });
  });

  r.post("/admin/api/orders/:id/dispatch", async (c) => {
    const { uber, google, config, clock } = c.get("services");
    const order = await getOrder(c.env.DB, c.req.param("id"));
    if (!order) return c.json({ error: "not_found" }, 404);
    if (order.fulfillment !== "delivery") return c.json({ error: "not_a_delivery", message: "This is a pickup order." }, 409);
    if (order.status !== "paid") return c.json({ error: "not_paid", message: `Cannot request a courier for a ${order.status} order.` }, 409);
    if (await activeDeliveryFor(c.env.DB, order.id)) {
      return c.json({ error: "courier_already_requested", message: "A courier is already on this one." }, 409);
    }
    if (!uber.configured()) {
      return c.json({ error: "uber_not_configured", message: "Uber is not set up on this site yet — deliver this one yourself." }, 503);
    }

    const address = deliveryAddressOf(order);
    if (!address) return c.json({ error: "no_address", message: "This order has no usable delivery address." }, 409);
    const phone = normalizePhone(order.customerPhone);
    if (!phone) return c.json({ error: "no_phone", message: "This order has no phone number the courier can call." }, 409);

    const now = clock();
    const nowSec = Math.floor(now.getTime() / 1000);
    const pickup = {
      name: "The Bull and Bloom", phone: config.studio.phone, businessName: "The Bull and Bloom",
      address: config.studio.address, notes: config.studio.pickupInstructions,
    };
    const dropoff = { name: order.customerName, phone, address, notes: address.notes || undefined };
    // Day-of dispatch always re-quotes: the checkout quote is minutes-old at best (D8).
    const window = deliveryWindow(now, now);
    // Idempotency is keyed on the order and its previous attempt, not on the clock: two admin tabs
    // pressing the button together send Uber the same key, so it books ONE courier and returns it
    // to both; a genuine re-request after a canceled job has a new key because `latest` changed.
    const previous = await latestDeliveryFor(c.env.DB, order.id);
    const idempotencyKey = `${order.id}:${previous?.id ?? "first"}`;

    let delivery;
    let quotedCents: number;
    try {
      const quote = await uber.quote({ pickup, dropoff, window, valueCents: order.bouquetCents });
      quotedCents = quote.feeCents;
      delivery = await uber.createDelivery({
        quoteId: quote.id, pickup, dropoff, window, valueCents: order.bouquetCents,
        itemName: deliveryItemName(sizeById(config, order.sizeId)?.name ?? order.sizeId),
        reference: order.id.slice(0, 8),
        idempotencyKey,
      });
    } catch (err) {
      // Spec §4.5: the order stays paid; Anthony retries or delivers himself.
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof UberError ? err.code : "unavailable";
      console.error(`dispatch: order ${order.id} failed (${code})`, message);
      return c.json({ error: "dispatch_failed", code, message }, 502);
    }

    try {
      await c.env.DB.batch([
        insertDeliveryStatement(c.env.DB, {
          id: crypto.randomUUID(), orderId: order.id, uberDeliveryId: delivery.id,
          status: knownStatus(delivery.status) ?? "pending",
          quotedCents, feeCents: delivery.feeCents, trackingUrl: delivery.trackingUrl, at: nowSec,
        }),
        enqueueCourierEmailStatement(c.env.DB, order.id, nowSec),
      ]);
    } catch (err) {
      // Uber already has this courier — the order stays paid, and pressing the button again
      // is safe: the idempotency key is unchanged, so Uber hands back the same delivery and
      // the (OR IGNORE) insert then succeeds. Nothing else is written here.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`dispatch: order ${order.id} booked Uber delivery ${delivery.id} but could not save the record`, message);
      return c.json({
        error: "record_not_saved",
        code: "record_not_saved",
        delivery: { id: delivery.id, trackingUrl: delivery.trackingUrl, status: delivery.status },
        message: `The courier is booked (Uber delivery ${delivery.id}) but the store could not save the record. Press Request courier again — Uber will return the same courier, not a second one.`,
      }, 500);
    }

    await background(c, drainOutbox({ db: c.env.DB, google, config, siteUrl: c.env.SITE_URL }, now));
    return c.json({ ok: true, delivery, variance: await varianceTotal(c.env.DB) });
  });
}
