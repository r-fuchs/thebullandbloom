import { Hono } from "hono";
import type { Context } from "hono";
import type { App, Services } from "../app";
import type { Env } from "../env";
import type { StoreConfig } from "../config";
import { availabilityFor, capFor, isOrderable } from "../core/capacity";
import { isYmd, ymdRange, addDays, ymdIn, humanDate } from "../core/time";
import { loadDefaults } from "../store/settings";
import { getOverrides } from "../store/overrides";
import { countUsed, tryInsertHeldOrder, attachSession, cancelOrder } from "../store/orders";
import { sizeById } from "../config";
import { UberError } from "../adapters/uber";
import { addressKey, deliveryWindow, fallbackFeeFor, parseAddress, pickupReadyFor } from "../core/delivery";
import { signQuote } from "../core/quote-token";

const MAX_DAYS = 62;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** How long a signed quote is honoured. Uber's own quotes live about 15 minutes. */
const QUOTE_TTL_SECONDS = 15 * 60;
/** A config fallback fee does not expire in any real sense; half an hour keeps a stale tab honest. */
const FALLBACK_TTL_SECONDS = 30 * 60;

export { humanDate };

type Ctx = Context<{ Bindings: Env; Variables: { services: Services } }>;

/** The value we declare to the courier when no size has been chosen yet: the cheapest bouquet. */
function lowestPriceCents(cfg: { sizes: Array<{ priceCents: number }> }): number {
  return Math.min(...cfg.sizes.map((s) => s.priceCents));
}

/** True when a customer can be shown a delivery option at all (spec §4.5). */
function deliveryOffered(uberConfigured: boolean, cfg: { delivery: { fallbackZips: string[] } }): boolean {
  return uberConfigured || cfg.delivery.fallbackZips.length > 0;
}

/**
 * The config fallback quote, signed and returned — or `outside_area`/`unavailable` when the zip
 * has no fallback fee either. Shared by the no-Uber path and the catch after a failed Uber quote
 * so the signed-fallback shape lives in exactly one place (both call sites answer the same JSON).
 */
async function fallbackResponse(
  c: Ctx, config: StoreConfig, secret: string, zip: string, date: string, addr: string, nowSec: number,
  noFallbackReason: "outside_area" | "unavailable" = "outside_area",
) {
  const fee = fallbackFeeFor(config, zip);
  if (fee === null) return c.json({ available: false, reason: noFallbackReason });
  return c.json({
    available: true, feeCents: fee, kind: "fallback" as const,
    quoteToken: await signQuote(secret, {
      feeCents: fee, quoteId: null, kind: "fallback", date, addr, exp: nowSec + FALLBACK_TTL_SECONDS,
    }),
  });
}

interface CheckoutBody {
  sizeId: string; date: string; fulfillment: "pickup";
  customer: { name: string; email: string; phone?: string }; note?: string;
}

function parseCheckout(raw: unknown): { ok: true; body: CheckoutBody } | { ok: false; error: string } {
  const b = raw as any;
  if (!b || typeof b !== "object") return { ok: false, error: "body must be an object" };
  if (typeof b.sizeId !== "string") return { ok: false, error: "sizeId required" };
  if (!isYmd(b.date)) return { ok: false, error: "date must be YYYY-MM-DD" };
  if (b.fulfillment !== "pickup") return { ok: false, error: "only pickup is available right now" };
  const c = b.customer;
  if (!c || typeof c.name !== "string" || c.name.trim().length < 1 || c.name.trim().length > 120) return { ok: false, error: "name required" };
  if (typeof c.email !== "string" || !EMAIL.test(c.email) || c.email.length > 200) return { ok: false, error: "valid email required" };
  if (c.phone !== undefined && (typeof c.phone !== "string" || c.phone.length > 40)) return { ok: false, error: "phone too long" };
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) return { ok: false, error: "note must be 500 characters or fewer" };
  return { ok: true, body: { sizeId: b.sizeId, date: b.date, fulfillment: "pickup",
    customer: { name: c.name.trim(), email: c.email.trim(), phone: c.phone?.trim() || undefined }, note: b.note?.trim() || undefined } };
}

export function publicRoutes(): App {
  const r: App = new Hono();

  r.get("/api/config", (c) => {
    const { config, uber } = c.get("services");
    return c.json({
      timezone: config.timezone,
      sizes: config.sizes,
      studio: { pickupInstructions: config.studio.pickupInstructions },
      delivery: { offered: deliveryOffered(uber.configured(), config) },
    });
  });

  r.get("/api/availability", async (c) => {
    const { config, clock } = c.get("services");
    const from = c.req.query("from"), to = c.req.query("to");
    if (!isYmd(from) || !isYmd(to)) return c.json({ error: "from and to must be YYYY-MM-DD" }, 400);
    const dates = ymdRange(from, to);
    if (dates.length === 0 || dates.length > MAX_DAYS) return c.json({ error: `range must be 1..${MAX_DAYS} days` }, 400);
    const [defaults, overrides, used] = await Promise.all([
      loadDefaults(c.env.DB, config.defaults),
      getOverrides(c.env.DB, from, to),
      countUsed(c.env.DB, from, to),
    ]);
    const clk = { now: clock(), tz: config.timezone };
    const days = dates.map((d) => availabilityFor(d, defaults, overrides.get(d) ?? null, used.get(d) ?? 0, clk));
    return c.json({ days });
  });

  r.post("/api/quote", async (c) => {
    const { config, clock, uber } = c.get("services");
    let raw: any;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (!isYmd(raw?.date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    const parsed = parseAddress(raw?.address);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const now = clock();
    const today = ymdIn(config.timezone, now);
    if (raw.date < today || raw.date > addDays(today, MAX_DAYS)) return c.json({ error: "date is outside the ordering window" }, 400);

    const nowSec = Math.floor(now.getTime() / 1000);
    const addr = addressKey(parsed.address);
    const value = lowestPriceCents(config);

    if (uber.configured()) {
      const ready = pickupReadyFor(config, raw.date, now);
      try {
        const q = await uber.quote({
          pickup: {
            name: "The Bull and Bloom", phone: config.studio.phone,
            businessName: "The Bull and Bloom", address: config.studio.address,
          },
          dropoff: { name: "Customer", phone: config.studio.phone, address: parsed.address },
          window: deliveryWindow(ready.at, now),
          valueCents: value,
        });
        const exp = Math.min(q.expiresAt, nowSec + QUOTE_TTL_SECONDS);
        const quoteToken = await signQuote(c.env.ADMIN_SECRET, {
          feeCents: q.feeCents, quoteId: q.id, kind: "uber", date: raw.date, addr, exp,
        });
        return c.json({ available: true, feeCents: q.feeCents, kind: "uber", quoteToken });
      } catch (err) {
        const code = err instanceof UberError ? err.code : "unavailable";
        console.error(`quote: uber ${code}`, err);
        return fallbackResponse(c, config, c.env.ADMIN_SECRET, parsed.address.zip, raw.date, addr, nowSec,
          code === "undeliverable" ? "outside_area" : "unavailable");
      }
    }

    return fallbackResponse(c, config, c.env.ADMIN_SECRET, parsed.address.zip, raw.date, addr, nowSec);
  });

  r.post("/api/checkout", async (c) => {
    const { config, clock, payments } = c.get("services");
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const parsed = parseCheckout(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { body } = parsed;
    const size = sizeById(config, body.sizeId);
    if (!size) return c.json({ error: "unknown size" }, 400);

    const now = clock();
    if (body.date > addDays(ymdIn(config.timezone, now), MAX_DAYS)) {
      return c.json({ error: "date too far ahead" }, 400);
    }

    const [defaults, overrides, used] = await Promise.all([
      loadDefaults(c.env.DB, config.defaults),
      getOverrides(c.env.DB, body.date, body.date),
      countUsed(c.env.DB, body.date, body.date),
    ]);
    const cap = capFor(body.date, defaults, overrides.get(body.date) ?? null);
    if (!isOrderable(body.date, cap - (used.get(body.date) ?? 0), defaults, { now, tz: config.timezone })) {
      return c.json({ error: "sold_out" }, 409);
    }

    const nowSec = Math.floor(now.getTime() / 1000);
    // D16: pad Stripe's own expiry 60s past the nominal hold window, and let our hold outlive
    // the Stripe session by a further 120s so a session expiring right at the edge can't race
    // ahead of a still-live hold.
    const stripeExpiresAt = nowSec + config.holdMinutes * 60 + 60;
    const holdUntil = stripeExpiresAt + 120;
    const orderId = crypto.randomUUID();
    const inserted = await tryInsertHeldOrder(c.env.DB, {
      id: orderId, date: body.date, sizeId: size.id, fulfillment: "pickup",
      customerName: body.customer.name, customerEmail: body.customer.email, customerPhone: body.customer.phone ?? null,
      addressJson: null, note: body.note ?? null, bouquetCents: size.priceCents, deliveryCents: 0, uberQuoteId: null,
    }, cap, nowSec, holdUntil);
    if (!inserted) return c.json({ error: "sold_out" }, 409);

    let session;
    try {
      session = await payments.createCheckout({
        orderId, customerEmail: body.customer.email,
        lineItems: [{ name: `${size.name} — pickup ${humanDate(body.date)}`, amountCents: size.priceCents, quantity: 1 }],
        successUrl: `${c.env.SITE_URL}/thanks?order=${orderId}`,
        cancelUrl: `${c.env.SITE_URL}/#order`,
        expiresAt: stripeExpiresAt,
      });
    } catch (err) {
      await cancelOrder(c.env.DB, orderId);
      console.error("checkout: payments failed", err);
      return c.json({ error: "payments_unavailable" }, 503);
    }

    try {
      await attachSession(c.env.DB, orderId, session.id);
    } catch (err) {
      await cancelOrder(c.env.DB, orderId);
      console.error(`checkout: attach failed after session ${session.id}`, err);
      return c.json({ error: "payments_unavailable" }, 503);
    }
    return c.json({ url: session.url });
  });

  return r;
}
