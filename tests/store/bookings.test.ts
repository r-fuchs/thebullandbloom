import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  attachSession, cancelBooking, cancelHeldById, cancelHeldBySession, countTaken, expireHolds, getBooking, listForOffer,
  markPaidBySession, tryInsertHeldBooking, type NewBooking,
} from "../../src/store/bookings";
import { BOOKING_PAID_KINDS, counts, enqueueForBookingSessionStatements } from "../../src/store/outbox";

let n = 0;
function fresh(sessionId = "s1", offerId = "wreath"): NewBooking {
  n += 1;
  return { id: `b${n}`, offerId, sessionId, customerName: "Pat", customerEmail: "pat@example.com", customerPhone: null, note: null, priceCents: 8500 };
}
const NOW = 1_800_000_000;

describe("bookings", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bookings").run();
    await env.DB.prepare("DELETE FROM outbox").run();
  });

  it("inserts while under the seat count, refuses at it", async () => {
    expect(await tryInsertHeldBooking(env.DB, fresh(), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldBooking(env.DB, fresh(), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldBooking(env.DB, fresh(), 2, NOW, NOW + 1800)).toBe(false);
    expect((await countTaken(env.DB, "wreath")).get("s1")).toBe(2);
  });
  it("a party holds several seats; the guard fits the whole party or none, and a smaller party can still take what is left", async () => {
    const trio = { ...fresh(), seats: 3 };
    expect(await tryInsertHeldBooking(env.DB, trio, 8, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldBooking(env.DB, { ...fresh(), seats: 4 }, 8, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldBooking(env.DB, { ...fresh(), seats: 2 }, 8, NOW, NOW + 1800)).toBe(false); // 7 taken, 2 do not fit
    const single = fresh();
    expect(await tryInsertHeldBooking(env.DB, single, 8, NOW, NOW + 1800)).toBe(true); // the last single seat does
    expect((await countTaken(env.DB, "wreath")).get("s1")).toBe(8);
    expect((await getBooking(env.DB, trio.id))?.seats).toBe(3);
    expect((await getBooking(env.DB, single.id))?.seats).toBe(1); // absent means one
  });
  it("counts per session and per offer; cancelled rows do not count", async () => {
    const a = fresh("s1"), b = fresh("s2"), c = fresh("s1", "other");
    for (const x of [a, b, c]) expect(await tryInsertHeldBooking(env.DB, x, 8, NOW, NOW + 1800)).toBe(true);
    await cancelBooking(env.DB, a.id);
    const taken = await countTaken(env.DB, "wreath");
    expect(taken.get("s1") ?? 0).toBe(0);
    expect(taken.get("s2")).toBe(1);
    expect((await countTaken(env.DB, "other")).get("s1")).toBe(1);
  });
  it("attaches a session, marks paid once with the tax and discount, ignores a second completion", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_b1");
    const paid = await markPaidBySession(env.DB, "cs_b1", "pi_b1", 680, 0);
    expect(paid).toMatchObject({ id: a.id, status: "paid", stripePaymentIntent: "pi_b1", taxCents: 680, discountCents: 0, holdExpiresAt: null });
    expect(await markPaidBySession(env.DB, "cs_b1", "pi_b1", 680, 0)).toBeNull();
  });
  it("resurrects a hold that expired before a late completion, but never an admin-cancelled paid seat", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 10);
    await attachSession(env.DB, a.id, "cs_b2");
    expect(await expireHolds(env.DB, NOW + 20)).toBe(1);
    expect((await getBooking(env.DB, a.id))?.status).toBe("cancelled");
    expect((await markPaidBySession(env.DB, "cs_b2", "pi_b2", 0, 0))?.status).toBe("paid");
    // Anthony refunds in Stripe and cancels in admin; a replayed completion must not undo that
    expect(await cancelBooking(env.DB, a.id)).toBe(true);
    expect(await markPaidBySession(env.DB, "cs_b2", "pi_b2", 0, 0)).toBeNull();
    expect((await getBooking(env.DB, a.id))?.status).toBe("cancelled");
  });
  it("runs extra statements in the same batch as the paid flip, and the outbox guard holds", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_b3");
    const paid = await markPaidBySession(env.DB, "cs_b3", "pi_b3", 0, 0, enqueueForBookingSessionStatements(env.DB, "cs_b3", BOOKING_PAID_KINDS, NOW));
    expect(paid?.status).toBe("paid");
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    const rows = await env.DB.prepare("SELECT kind, order_id FROM outbox ORDER BY kind").all<any>();
    expect(rows.results).toEqual([
      { kind: "booking_confirmed_customer", order_id: a.id },
      { kind: "booking_confirmed_owner", order_id: a.id },
    ]);
    // a session nobody paid for enqueues nothing
    await env.DB.batch(enqueueForBookingSessionStatements(env.DB, "cs_nobody", BOOKING_PAID_KINDS, NOW));
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
  });
  it("cancelHeldById frees a held row only; paid, cancelled and unknown rows return false", async () => {
    const a = fresh(), b = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await tryInsertHeldBooking(env.DB, b, 8, NOW, NOW + 1800);
    await env.DB.prepare("UPDATE bookings SET status = 'paid' WHERE id = ?").bind(b.id).run();
    expect(await cancelHeldById(env.DB, a.id)).toBe(true);
    expect((await getBooking(env.DB, a.id))?.status).toBe("cancelled");
    expect(await cancelHeldById(env.DB, a.id)).toBe(false);
    expect(await cancelHeldById(env.DB, b.id)).toBe(false);
    expect((await getBooking(env.DB, b.id))?.status).toBe("paid");
    expect(await cancelHeldById(env.DB, "nope")).toBe(false);
  });
  it("cancels a held booking by session but never a paid one", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_b4");
    await markPaidBySession(env.DB, "cs_b4", "pi_b4", 0, 0);
    expect(await cancelHeldBySession(env.DB, "cs_b4")).toBe(false);
    const b = fresh();
    await tryInsertHeldBooking(env.DB, b, 8, NOW, NOW + 1800);
    await attachSession(env.DB, b.id, "cs_b5");
    expect(await cancelHeldBySession(env.DB, "cs_b5")).toBe(true);
    expect((await getBooking(env.DB, b.id))?.status).toBe("cancelled");
  });
  it("cancelBooking frees a held or paid seat and returns false on a cancelled or unknown one (D53)", async () => {
    const a = fresh("s9");
    await tryInsertHeldBooking(env.DB, a, 1, NOW, NOW + 1800);
    expect(await tryInsertHeldBooking(env.DB, fresh("s9"), 1, NOW, NOW + 1800)).toBe(false);
    expect(await cancelBooking(env.DB, a.id)).toBe(true);
    expect(await cancelBooking(env.DB, a.id)).toBe(false);
    expect(await cancelBooking(env.DB, "nope")).toBe(false);
    expect(await tryInsertHeldBooking(env.DB, fresh("s9"), 1, NOW, NOW + 1800)).toBe(true);
  });
  it("expires holds past their deadline only", async () => {
    const a = fresh(), b = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 100);
    await tryInsertHeldBooking(env.DB, b, 8, NOW, NOW + 5000);
    expect(await expireHolds(env.DB, NOW + 200)).toBe(1);
    expect((await getBooking(env.DB, a.id))?.status).toBe("cancelled");
    expect((await getBooking(env.DB, b.id))?.status).toBe("held");
  });
  it("lists an offer's bookings oldest first, every status", async () => {
    const a = fresh("s1"), b = fresh("s2"), c = fresh("s1", "other");
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await tryInsertHeldBooking(env.DB, b, 8, NOW + 1, NOW + 1800);
    await tryInsertHeldBooking(env.DB, c, 8, NOW + 2, NOW + 1800);
    await cancelBooking(env.DB, b.id);
    expect((await listForOffer(env.DB, "wreath")).map((x) => [x.id, x.status])).toEqual([[a.id, "held"], [b.id, "cancelled"]]);
  });
});
