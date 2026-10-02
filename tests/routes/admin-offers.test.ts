import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp, asAdmin, offersConfig, WREATH, OFF_OFFER } from "../helpers";

const INSERT = `INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note, price_cents)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8500)`;
async function booking(id: string, status: string, sessionId: string, name: string, at = 1, offerId = WREATH.id) {
  await env.DB.prepare(INSERT).bind(id, at, status, offerId, sessionId, name, `${name.toLowerCase()}@example.com`, null, null).run();
}

describe("admin offers (Plan 7)", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM bookings").run(); });

  it("requires an Access identity", async () => {
    const { fetch } = testApp(undefined, offersConfig());
    expect((await fetch("/admin/api/offers")).status).toBe(401);
    expect((await fetch("/admin/api/bookings/x/cancel", { method: "POST" })).status).toBe(401);
  });

  it("lists every offer with recent-and-future sessions, counts, and the bookings", async () => {
    await booking("a1", "paid", "sat", "Jane", 1);
    await booking("a2", "held", "sat", "Bob", 2);
    await booking("a3", "cancelled", "sat", "Cat", 3);
    await booking("a4", "paid", "past", "Dan", 4);
    const { fetch } = testApp(undefined, offersConfig());
    const { offers } = await (await asAdmin(fetch)("/admin/api/offers")).json() as any;
    expect(offers.map((o: any) => [o.id, o.enabled])).toEqual([[WREATH.id, true], [OFF_OFFER.id, false]]);
    const w = offers[0];
    // "past" is 2026-09-01, inside the 30-day lookback from the 2026-09-08 test clock, so it still shows
    expect(w.sessions.map((s: any) => s.id)).toEqual(["past", "today", "sat"]);
    const sat = w.sessions[2];
    expect(sat).toMatchObject({ date: "2026-09-12", start: "18:00", seats: 2, paidCount: 1, heldCount: 1 });
    expect(sat.bookings.map((b: any) => [b.id, b.status, b.customerName])).toEqual([["a1", "paid", "Jane"], ["a2", "held", "Bob"], ["a3", "cancelled", "Cat"]]);
    expect(sat.bookings[0]).toMatchObject({ customerEmail: "jane@example.com", customerPhone: null, note: null, createdAt: 1 });
    expect(w.sessions[0].bookings.map((b: any) => b.id)).toEqual(["a4"]);
    expect(offers[1].sessions.every((s: any) => s.bookings.length === 0)).toBe(true);
  });

  it("hides sessions older than 30 days", async () => {
    const old = { ...WREATH, sessions: [{ id: "old", date: "2026-08-01", start: "18:00", seats: 8 }, ...WREATH.sessions] };
    const { fetch } = testApp(undefined, offersConfig([old]));
    const { offers } = await (await asAdmin(fetch)("/admin/api/offers")).json() as any;
    expect(offers[0].sessions.map((s: any) => s.id)).toEqual(["past", "today", "sat"]);
  });

  it("cancel frees the seat for held or paid, and is 404 for cancelled or unknown (D53)", async () => {
    await booking("c1", "paid", "sat", "Jane");
    await booking("c2", "held", "sat", "Bob");
    const { fetch } = testApp(undefined, offersConfig());
    const as = asAdmin(fetch);
    let { offers } = await (await fetch("/api/offers")).json() as any;
    expect(offers[0].sessions.find((s: any) => s.id === "sat").remaining).toBe(0);
    expect(await (await as("/admin/api/bookings/c1/cancel", { method: "POST" })).json()).toEqual({ ok: true });
    expect((await as("/admin/api/bookings/c1/cancel", { method: "POST" })).status).toBe(404);
    expect((await as("/admin/api/bookings/nope/cancel", { method: "POST" })).status).toBe(404);
    expect(await (await as("/admin/api/bookings/c2/cancel", { method: "POST" })).json()).toEqual({ ok: true });
    ({ offers } = await (await fetch("/api/offers")).json() as any);
    expect(offers[0].sessions.find((s: any) => s.id === "sat")).toMatchObject({ remaining: 2, bookable: true });
  });
});
