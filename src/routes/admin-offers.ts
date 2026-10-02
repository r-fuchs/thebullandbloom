import type { App } from "../app";
import { offersOf } from "../config";
import { sessionStart } from "../core/offers";
import { addDays, ymdIn } from "../core/time";
import { cancelBooking, listForOffer } from "../store/bookings";

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

  // D53: refunds happen in Stripe; this only frees the seat.
  r.post("/admin/api/bookings/:id/cancel", async (c) => {
    const did = await cancelBooking(c.env.DB, c.req.param("id"));
    if (!did) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
