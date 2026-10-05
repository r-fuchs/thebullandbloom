import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp, asAdmin, offersConfig, WREATH, OFF_OFFER } from "../helpers";
import { loadConfig } from "../../src/config";

const INSERT = `INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note, price_cents, seats)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8500, ?)`;
async function booking(id: string, status: string, sessionId: string, name: string, at = 1, offerId = WREATH.id, seats = 1) {
  await env.DB.prepare(INSERT).bind(id, at, status, offerId, sessionId, name, `${name.toLowerCase()}@example.com`, null, null, seats).run();
}

describe("admin offers (Plan 7)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bookings").run();
    await env.DB.prepare("DELETE FROM outbox").run();
  });

  it("requires an Access identity", async () => {
    const { fetch } = testApp(undefined, offersConfig());
    expect((await fetch("/admin/api/offers")).status).toBe(401);
    expect((await fetch("/admin/api/bookings/x/cancel", { method: "POST" })).status).toBe(401);
    expect((await fetch(`/admin/api/offers/${WREATH.id}/sessions/sat/bookings`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("lists every offer with recent-and-future sessions, counts, and the bookings", async () => {
    await booking("a1", "paid", "sat", "Jane", 1);
    await booking("a2", "held", "sat", "Bob", 2, WREATH.id, 2); // a pair: counts as two held seats
    await booking("a3", "cancelled", "sat", "Cat", 3);
    await booking("a4", "paid", "past", "Dan", 4);
    const { fetch } = testApp(undefined, offersConfig());
    const { offers } = await (await asAdmin(fetch)("/admin/api/offers")).json() as any;
    expect(offers.map((o: any) => [o.id, o.enabled])).toEqual([[WREATH.id, true], [OFF_OFFER.id, false]]);
    const w = offers[0];
    // "past" is 2026-09-01, inside the 30-day lookback from the 2026-09-08 test clock, so it still shows
    expect(w.sessions.map((s: any) => s.id)).toEqual(["past", "today", "sat"]);
    const sat = w.sessions[2];
    expect(sat).toMatchObject({ date: "2026-09-12", start: "18:00", seats: 2, paidCount: 1, heldCount: 2 });
    expect(sat.bookings.map((b: any) => b.seats)).toEqual([1, 2, 1]);
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

  describe("adding a party that paid in person", () => {
    const add = (fetch: any, sessionId: string, body: unknown, offerId = WREATH.id) =>
      asAdmin(fetch)(`/admin/api/offers/${offerId}/sessions/${sessionId}/bookings`, { method: "POST", body: JSON.stringify(body) });

    it("records a paid party at once, with the offer's seat price, so the site stops selling those seats", async () => {
      const { fetch, mailer } = testApp(undefined, offersConfig());
      const res = await add(fetch, "sat", { name: " Pat Lee ", email: "pat@example.com", phone: "518-555-0100", seats: 2, note: "Paid in person" });
      expect(res.status).toBe(200);
      const { id } = await res.json() as any;
      const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first<any>();
      expect(row).toMatchObject({
        status: "paid", offer_id: WREATH.id, session_id: "sat", customer_name: "Pat Lee", customer_email: "pat@example.com",
        customer_phone: "518-555-0100", note: "Paid in person", price_cents: 8500, seats: 2, hold_expires_at: null, stripe_session_id: null,
      });
      expect(row.created_at).toBe(Math.floor(new Date("2026-09-08T14:00:00Z").getTime() / 1000));
      const { offers } = await (await fetch("/api/offers")).json() as any;
      expect(offers[0].sessions.find((s: any) => s.id === "sat")).toMatchObject({ remaining: 0, bookable: false });
      const admin = await (await asAdmin(fetch)("/admin/api/offers")).json() as any;
      expect(admin.offers[0].sessions[2]).toMatchObject({ paidCount: 2, heldCount: 0 });
      // The same two emails as a Stripe booking, queued with the row and sent before the response (no ExecutionContext in tests).
      const kinds = await env.DB.prepare("SELECT kind, done_at FROM outbox WHERE order_id = ? ORDER BY kind").bind(id).all<any>();
      expect(kinds.results.map((k) => [k.kind, k.done_at !== null])).toEqual([["booking_confirmed_customer", true], ["booking_confirmed_owner", true]]);
      expect(mailer.sent.map((m) => m.to)).toEqual(["pat@example.com", loadConfig().studio.ownerEmail]);
      expect(mailer.sent[0].subject).toBe("Your 2 seats at Wreath & Sip");
      expect(mailer.sent[1].text).toContain("paid in person");
    });

    it("needs only a name: a walk-in without an email is still a seat, and only Anthony gets mail", async () => {
      const { fetch, mailer } = testApp(undefined, offersConfig());
      expect((await add(fetch, "sat", { name: "Walk In" })).status).toBe(200);
      const row = await env.DB.prepare("SELECT customer_email, customer_phone, note, seats FROM bookings").first<any>();
      expect(row).toEqual({ customer_email: "", customer_phone: null, note: null, seats: 1 });
      const kinds = await env.DB.prepare("SELECT kind FROM outbox").all<any>();
      expect(kinds.results.map((k) => k.kind)).toEqual(["booking_confirmed_owner"]);
      expect(mailer.sent.map((m) => m.to)).toEqual([loadConfig().studio.ownerEmail]);
    });

    it("ignores the booking cutoff and the offer switch: admin is standing next to the customer", async () => {
      const { fetch } = testApp(undefined, offersConfig());
      expect((await add(fetch, "today", { name: "Late" })).status).toBe(200); // inside the 24-hour cutoff
      expect((await add(fetch, "sat", { name: "Off" }, OFF_OFFER.id)).status).toBe(200); // offer switched off
    });

    it("is guarded by the seat count like any booking: sold_out says how many are left", async () => {
      await booking("p1", "paid", "sat", "Jane");
      const { fetch, mailer } = testApp(undefined, offersConfig());
      const res = await add(fetch, "sat", { name: "Pair", email: "pair@example.com", seats: 2 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "sold_out", remaining: 1 });
      // The outbox rows ride in the insert's batch, guarded on the row: a party that did not fit emails nobody.
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<any>()).n).toBe(0);
      expect(mailer.sent).toEqual([]);
      expect((await add(fetch, "sat", { name: "Single", seats: 1 })).status).toBe(200);
      expect((await add(fetch, "sat", { name: "Nobody", seats: 1 })).status).toBe(409);
    });

    it("rejects an unknown offer or session, and a bad body", async () => {
      const { fetch } = testApp(undefined, offersConfig());
      expect((await add(fetch, "sat", { name: "X" }, "nope")).status).toBe(404);
      expect((await add(fetch, "nope", { name: "X" })).status).toBe(404);
      expect((await add(fetch, "sat", { name: "" })).status).toBe(400);
      expect((await add(fetch, "sat", { email: "x@example.com" })).status).toBe(400);
      expect((await add(fetch, "sat", { name: "X", email: "not-an-email" })).status).toBe(400);
      expect((await add(fetch, "sat", { name: "X", seats: 0 })).status).toBe(400);
      expect((await add(fetch, "sat", { name: "X", seats: 3 })).status).toBe(400); // "sat" has two seats in all
      expect((await add(fetch, "sat", { name: "X", seats: 1.5 })).status).toBe(400);
      expect((await add(fetch, "sat", { name: "X", note: "n".repeat(501) })).status).toBe(400);
      expect((await asAdmin(fetch)(`/admin/api/offers/${WREATH.id}/sessions/sat/bookings`, { method: "POST", body: "{" })).status).toBe(400);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings").first<any>()).n).toBe(0);
    });
  });
});
