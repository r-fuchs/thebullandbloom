import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp, offersConfig, WREATH, OFF_OFFER } from "../helpers";
import { loadConfig } from "../../src/config";
import { tryInsertHeldBooking } from "../../src/store/bookings";

const NOW_SEC = Math.floor(new Date("2026-09-08T14:00:00Z").getTime() / 1000);
const good = { offerId: WREATH.id, sessionId: "sat", customer: { name: "Jane Doe", email: "jane@example.com", phone: "518-555-0100" }, note: "first wreath" };
const post = (fetch: any, body: unknown) =>
  fetch("/api/book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function held(id: string, sessionId: string, offerId = WREATH.id) {
  await tryInsertHeldBooking(env.DB, { id, offerId, sessionId, customerName: "X", customerEmail: "x@example.com", customerPhone: null, note: null, priceCents: 8500 }, 99, NOW_SEC, NOW_SEC + 1800);
}

describe("GET /api/offers", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM bookings").run(); });

  it("lists enabled offers with today-onward sessions, remaining seats and bookable, and the pixel id", async () => {
    await held("h1", "sat");
    await held("h2", "sat");
    await env.DB.prepare("UPDATE bookings SET status = 'paid' WHERE id = 'h2'").run();
    const { fetch } = testApp(undefined, offersConfig([WREATH, OFF_OFFER], "123"));
    const r = await fetch("/api/offers");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.marketing).toEqual({ metaPixelId: "123" });
    expect(body.offers.map((o: any) => o.id)).toEqual([WREATH.id]);
    const o = body.offers[0];
    expect(o).toMatchObject({ slug: "wreath-test", name: "Wreath & Sip", priceCents: 8500, durationMinutes: 120, showOnHome: true, image: "assets/wreath.jpg" });
    expect(o).not.toHaveProperty("enabled");
    expect(o.sessions).toEqual([
      { id: "today", date: "2026-09-08", start: "15:00", seats: 8, remaining: 8, bookable: false },
      { id: "sat", date: "2026-09-12", start: "18:00", seats: 2, remaining: 0, bookable: false },
    ]);
    expect(JSON.stringify(body)).not.toContain("x@example.com");
  });
  it("a cancelled booking frees its seat", async () => {
    await held("h3", "sat");
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = 'h3'").run();
    const { fetch } = testApp(undefined, offersConfig());
    const { offers } = await (await fetch("/api/offers")).json() as any;
    expect(offers[0].sessions.find((s: any) => s.id === "sat")).toMatchObject({ remaining: 2, bookable: true });
  });
  it("returns no offers and an empty pixel id when the config has neither key", async () => {
    const { offers: _o, marketing: _m, ...bare } = loadConfig();
    const { fetch } = testApp(undefined, bare as any);
    expect(await (await fetch("/api/offers")).json()).toEqual({ offers: [], marketing: { metaPixelId: "" } });
  });
});

describe("POST /api/book", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM bookings").run(); });

  it("holds a seat, creates a Checkout Session for one seat at the studio, returns the url", async () => {
    const { fetch, payments } = testApp(undefined, offersConfig());
    const r = await post(fetch, good);
    expect(r.status).toBe(200);
    const { url } = await r.json() as any;
    expect(url).toMatch(/^https:\/\/checkout\.example\//);
    const c = payments.created[0];
    expect(c.lineItems).toEqual([{ name: "Wreath & Sip — Sat Sep 12, 6 pm", amountCents: 8500, quantity: 1, taxCategory: "workshop" }]);
    expect(c.taxAddress).toEqual(loadConfig().studio.address);
    expect(c.customerEmail).toBe("jane@example.com");
    expect(c.expiresAt).toBe(NOW_SEC + 30 * 60 + 60);
    expect(c.successUrl).toBe(`https://thebullandbloom.com/thanks?booking=${c.orderId}&offer=${WREATH.id}`);
    expect(c.cancelUrl).toBe("https://thebullandbloom.com/offers/wreath-test");
    const row = await env.DB.prepare("SELECT status, offer_id, session_id, customer_name, customer_phone, note, price_cents, stripe_session_id, hold_expires_at FROM bookings WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toMatchObject({ status: "held", offer_id: WREATH.id, session_id: "sat", customer_name: "Jane Doe", customer_phone: "518-555-0100", note: "first wreath", price_cents: 8500, hold_expires_at: c.expiresAt + 120 });
    expect(row.stripe_session_id).toMatch(/^cs_/);
  });
  it("sells the last seat once under two concurrent posts and says sold_out to the other", async () => {
    await held("h4", "sat");
    const { fetch, payments } = testApp(undefined, offersConfig());
    const [a, b] = await Promise.all([post(fetch, good), post(fetch, good)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(await lost.json()).toEqual({ error: "sold_out" });
    expect(payments.created).toHaveLength(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE session_id = 'sat' AND status = 'held'").first<any>();
    expect(n.n).toBe(2);
  });
  it("says closed inside the cutoff, disabled for an offer that is off, and never touches Stripe", async () => {
    const { fetch, payments } = testApp(undefined, offersConfig());
    const closed = await post(fetch, { ...good, sessionId: "today" });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({ error: "closed" });
    const past = await post(fetch, { ...good, sessionId: "past" });
    expect(await past.json()).toEqual({ error: "closed" });
    const off = await post(fetch, { ...good, offerId: OFF_OFFER.id });
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "disabled" });
    expect(payments.created).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings").first<any>()).n).toBe(0);
  });
  it("validates the body", async () => {
    const { fetch } = testApp(undefined, offersConfig());
    expect((await fetch("/api/book", { method: "POST", body: "{" })).status).toBe(400);
    expect((await post(fetch, { ...good, offerId: "nope" })).status).toBe(400);
    expect((await post(fetch, { ...good, sessionId: "nope" })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "", email: "jane@example.com" } })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "Jane", email: "not-an-email" } })).status).toBe(400);
    expect((await post(fetch, { ...good, note: "x".repeat(501) })).status).toBe(400);
    const { offerId: _o, ...noOffer } = good;
    expect((await post(fetch, noOffer)).status).toBe(400);
  });
  it("releases the seat and returns 503 when Stripe fails", async () => {
    const { fetch, payments } = testApp(undefined, offersConfig());
    payments.failNext = true;
    const r = await post(fetch, good);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "payments_unavailable" });
    const rows = await env.DB.prepare("SELECT status FROM bookings").all<any>();
    expect(rows.results).toEqual([{ status: "cancelled" }]);
    // the seat is free again
    expect((await post(fetch, good)).status).toBe(200);
  });
});
