import type { App } from "../app";
import { offerById, offersOf } from "../config";
import { seatsRemaining, sessionStart } from "../core/offers";
import { addDays, ymdIn } from "../core/time";
import { cancelBooking, countTaken, listForOffer, tryInsertPaidBooking } from "../store/bookings";
import { EMAIL } from "./public";

const LOOKBACK_DAYS = 30;

/** Plan 7 §3.8. Mounted from adminRoutes() AFTER its Access middleware, so every route here needs an identity. */
export function registerOffersAdmin(r: App): void {
  r.get("/admin/api/offers", async (c) => {
    const { config, clock } = c.get("services");
    const since = addDays(ymdIn(config.timezone, clock()), -LOOKBACK_DAYS);
    const offers = [];
    for (const o of offersOf(config)) {
      const all = await listForOffer(c.env.DB, o.id);
      const sessions = o.sessions
        .filter((s) => s.date >= since)
        .sort((a, b) => sessionStart(a, config.timezone).getTime() - sessionStart(b, config.timezone).getTime())
        .map((s) => {
          const rows = all.filter((b) => b.sessionId === s.id);
          return {
            id: s.id, date: s.date, start: s.start, seats: s.seats,
            // seat counts, not party counts: a booking of three is three of the eight
            paidCount: rows.filter((b) => b.status === "paid").reduce((n, b) => n + b.seats, 0),
            heldCount: rows.filter((b) => b.status === "held").reduce((n, b) => n + b.seats, 0),
            bookings: rows.map((b) => ({
              id: b.id, customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: b.customerPhone,
              note: b.note, status: b.status, createdAt: b.createdAt, seats: b.seats,
            })),
          };
        });
      offers.push({ id: o.id, slug: o.slug, name: o.name, enabled: o.enabled, showOnHome: o.showOnHome, priceCents: o.priceCents, sessions });
    }
    return c.json({ offers });
  });

  // A party that paid at the studio: Anthony records it here so the seats leave the public count.
  // The cutoff and the offer switch do not apply (he is standing next to them); the seat guard does.
  // Email is optional, since a walk-in may not give one, and nothing is sent either way.
  r.post("/admin/api/offers/:offerId/sessions/:sessionId/bookings", async (c) => {
    const { config, clock } = c.get("services");
    const offer = offerById(config, c.req.param("offerId"));
    if (!offer) return c.json({ error: "unknown offer" }, 404);
    const session = offer.sessions.find((s) => s.id === c.req.param("sessionId"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    let b: any;
    try { b = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (!b || typeof b !== "object") return c.json({ error: "body must be an object" }, 400);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 1 || name.length > 120) return c.json({ error: "name required" }, 400);
    const email = typeof b.email === "string" ? b.email.trim() : "";
    if (b.email != null && typeof b.email !== "string") return c.json({ error: "email must be text" }, 400);
    if (email !== "" && (!EMAIL.test(email) || email.length > 200)) return c.json({ error: "valid email required" }, 400);
    const phone = typeof b.phone === "string" ? b.phone.trim() : "";
    if ((b.phone != null && typeof b.phone !== "string") || phone.length > 40) return c.json({ error: "phone too long" }, 400);
    const seats = b.seats === undefined ? 1 : b.seats;
    if (!Number.isInteger(seats) || seats < 1 || seats > session.seats) return c.json({ error: `seats must be a whole number from 1 to ${session.seats}` }, 400);
    if (b.note != null && (typeof b.note !== "string" || b.note.length > 500)) return c.json({ error: "note must be 500 characters or fewer" }, 400);

    const nowSec = Math.floor(clock().getTime() / 1000);
    const id = crypto.randomUUID();
    const inserted = await tryInsertPaidBooking(c.env.DB, {
      id, offerId: offer.id, sessionId: session.id, customerName: name, customerEmail: email, customerPhone: phone || null,
      note: (typeof b.note === "string" && b.note.trim()) || null, priceCents: offer.priceCents, seats,
    }, session.seats, nowSec);
    if (!inserted) {
      const taken = (await countTaken(c.env.DB, offer.id)).get(session.id) ?? 0;
      return c.json({ error: "sold_out", remaining: seatsRemaining(session.seats, taken) }, 409);
    }
    return c.json({ ok: true, id });
  });

  // D53: refunds happen in Stripe; this only frees the seat.
  r.post("/admin/api/bookings/:id/cancel", async (c) => {
    const did = await cancelBooking(c.env.DB, c.req.param("id"));
    if (!did) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
