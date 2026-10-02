import { Hono } from "hono";
import type { App } from "../app";
import { offerById, offerBySlug, offersOf, type Offer } from "../config";
import { bookingBlocker, isBookable, seatsRemaining, sessionLabel, sessionStart } from "../core/offers";
import { ymdIn } from "../core/time";
import { attachSession, cancelBooking, countTaken, tryInsertHeldBooking } from "../store/bookings";

/** The most seats one booking may hold: friends come in twos and threes, not busloads. */
export const MAX_PARTY = 6;
import type { CheckoutLineItem } from "../adapters/payments";
import { parseCustomer } from "./public";

/** Plan 7: classes sold by the seat. Config is the catalog (D47); D1 counts the seats. */
export function offerRoutes(): App {
  const r: App = new Hono();

  r.get("/api/offers", async (c) => {
    const { config, clock } = c.get("services");
    const now = clock();
    const clk = { now, tz: config.timezone };
    const today = ymdIn(config.timezone, now);
    const offers = [];
    for (const o of offersOf(config).filter((x) => x.enabled)) {
      const taken = await countTaken(c.env.DB, o.id);
      const sessions = o.sessions
        .filter((s) => s.date >= today)
        .sort((a, b) => sessionStart(a, clk.tz).getTime() - sessionStart(b, clk.tz).getTime())
        .map((s) => {
          const t = taken.get(s.id) ?? 0;
          return { id: s.id, date: s.date, start: s.start, seats: s.seats, remaining: seatsRemaining(s.seats, t), bookable: isBookable(o, s, t, clk) };
        });
      offers.push({
        id: o.id, slug: o.slug, name: o.name, tagline: o.tagline, description: o.description, image: o.image, imageAlt: o.imageAlt,
        priceCents: o.priceCents, durationMinutes: o.durationMinutes, bookingClosesHoursBefore: o.bookingClosesHoursBefore,
        showOnHome: o.showOnHome, sessions,
      });
    }
    return c.json({ offers, marketing: { metaPixelId: config.marketing?.metaPixelId ?? "" } });
  });

  r.post("/api/book", async (c) => {
    const { config, clock, payments } = c.get("services");
    let b: any;
    try { b = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (!b || typeof b !== "object") return c.json({ error: "body must be an object" }, 400);
    if (typeof b.offerId !== "string" || typeof b.sessionId !== "string") return c.json({ error: "offerId and sessionId required" }, 400);
    const cust = parseCustomer(b.customer);
    if (!cust.ok) return c.json({ error: cust.error }, 400);
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) return c.json({ error: "note must be 500 characters or fewer" }, 400);
    const seats = b.seats === undefined ? 1 : b.seats;
    if (!Number.isInteger(seats) || seats < 1 || seats > MAX_PARTY) return c.json({ error: `seats must be a whole number from 1 to ${MAX_PARTY}` }, 400);
    const offer = offerById(config, b.offerId);
    if (!offer) return c.json({ error: "unknown offer" }, 400);
    const session = offer.sessions.find((s) => s.id === b.sessionId);
    if (!session) return c.json({ error: "unknown session" }, 400);

    const now = clock();
    const blocker = bookingBlocker(offer, session, { now, tz: config.timezone });
    if (blocker) return c.json({ error: blocker }, 409);

    // D16, as /api/checkout: Stripe's expiry 60s past the hold window, our hold 120s past that.
    const nowSec = Math.floor(now.getTime() / 1000);
    const stripeExpiresAt = nowSec + config.holdMinutes * 60 + 60;
    const holdUntil = stripeExpiresAt + 120;
    const bookingId = crypto.randomUUID();
    const inserted = await tryInsertHeldBooking(c.env.DB, {
      id: bookingId, offerId: offer.id, sessionId: session.id,
      customerName: cust.customer.name, customerEmail: cust.customer.email, customerPhone: cust.customer.phone ?? null,
      note: b.note?.trim() || null, priceCents: offer.priceCents, seats,
    }, session.seats, nowSec, holdUntil);
    if (!inserted) {
      // The party did not fit. Say how many seats are left so the page can offer a smaller party instead of a dead end.
      const taken = (await countTaken(c.env.DB, offer.id)).get(session.id) ?? 0;
      return c.json({ error: "sold_out", remaining: seatsRemaining(session.seats, taken) }, 409);
    }

    const lineItems: CheckoutLineItem[] = [
      { name: `${offer.name} — ${sessionLabel(session)}`, amountCents: offer.priceCents, quantity: seats, taxCategory: "workshop" },
    ];
    let stripeSession;
    try {
      stripeSession = await payments.createCheckout({
        orderId: bookingId, customerEmail: cust.customer.email, customerName: cust.customer.name,
        taxAddress: config.studio.address, lineItems,
        successUrl: `${c.env.SITE_URL}/thanks?booking=${bookingId}&offer=${offer.id}&seats=${seats}`,
        cancelUrl: `${c.env.SITE_URL}/offers/${offer.slug}`,
        expiresAt: stripeExpiresAt,
      });
    } catch (err) {
      await cancelBooking(c.env.DB, bookingId);
      console.error("book: payments failed", err);
      return c.json({ error: "payments_unavailable" }, 503);
    }
    try {
      await attachSession(c.env.DB, bookingId, stripeSession.id);
    } catch (err) {
      await cancelBooking(c.env.DB, bookingId);
      console.error(`book: attach failed after session ${stripeSession.id}`, err);
      return c.json({ error: "payments_unavailable" }, 503);
    }
    return c.json({ url: stripeSession.url });
  });

  // One static page serves every offer; the script reads the slug from the URL (D49). An unknown or
  // retired slug still gets the page, which then says "Not currently offered": an ad link never dead-ends.
  r.get("/offers/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (slug.includes(".")) return c.env.ASSETS.fetch(c.req.raw); // offer.js, offer.css in the test harness
    const page = await c.env.ASSETS.fetch(new URL("/offers/", c.req.url));
    const offer = offerBySlug(c.get("services").config, slug);
    if (!offer || !offer.enabled) return page;
    return withShareTags(page, offer, c.env.SITE_URL);
  });

  // An ad link typed with a trailing slash: send it to the canonical address so the page's relative assets resolve.
  r.get("/offers/:slug/", (c) => c.redirect(`/offers/${c.req.param("slug")}`, 301));

  return r;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Facebook, iMessage and the rest read the head without running offer.js, so a live offer's title,
 *  description and photo go into the static page here. The page itself is untouched otherwise. */
export function withShareTags(page: Response, offer: Offer, siteUrl: string): Response {
  const base = siteUrl.replace(/\/+$/, "");
  const title = `${offer.name} — The Bull and Bloom`;
  const image = `${base}/${offer.image}`;
  const tags: Array<[string, string, string]> = [
    ["name", "description", offer.description],
    ["property", "og:title", title],
    ["property", "og:description", offer.tagline],
    ["property", "og:image", image],
    ...(offer.imageWidth && offer.imageHeight
      ? [["property", "og:image:width", String(offer.imageWidth)], ["property", "og:image:height", String(offer.imageHeight)]] as Array<[string, string, string]>
      : []),
    ["property", "og:url", `${base}/offers/${offer.slug}`],
    ["property", "og:type", "website"],
    ["name", "twitter:card", "summary_large_image"],
  ];
  const metas = tags.map(([attr, k, v]) => `<meta ${attr}="${k}" content="${escapeHtml(v)}">`).join("\n");
  return new HTMLRewriter()
    .on("head > title", { element(el) { el.setInnerContent(title); el.after("\n" + metas, { html: true }); } })
    .transform(page);
}

