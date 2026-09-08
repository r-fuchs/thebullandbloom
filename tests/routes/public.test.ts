import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { testApp, seedAdminOverride, peekNextSessionId } from "../helpers";

describe("GET /api/config", () => {
  it("returns sizes and timezone without the studio address", async () => {
    const { fetch } = testApp();
    const r = await fetch("/api/config");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.timezone).toBe("America/New_York");
    expect(body.sizes[0]).toHaveProperty("priceCents");
    expect(JSON.stringify(body)).not.toContain("pickupAddress");
  });
});

describe("GET /api/availability", () => {
  it("returns one entry per day with orderable computed from clock and cutoff", async () => {
    // clock: Tue 2026-09-08 10:00 EDT, before the 11:00 cutoff
    const { fetch } = testApp();
    const r = await fetch("/api/availability?from=2026-09-07&to=2026-09-09");
    expect(r.status).toBe(200);
    const { days } = await r.json() as any;
    expect(days.map((d: any) => [d.date, d.open, d.orderable])).toEqual([
      ["2026-09-07", false, false], // Monday: closed weekday
      ["2026-09-08", true, true],   // today, before cutoff
      ["2026-09-09", true, true],
    ]);
  });
  it("honours admin overrides", async () => {
    await seedAdminOverride("2026-09-10", null, true);
    const { fetch } = testApp();
    const { days } = await (await fetch("/api/availability?from=2026-09-10&to=2026-09-10")).json() as any;
    expect(days[0]).toMatchObject({ open: false, remaining: 0, orderable: false });
  });
  it("rejects bad or oversized ranges", async () => {
    const { fetch } = testApp();
    expect((await fetch("/api/availability?from=2026-9-1&to=2026-09-09")).status).toBe(400);
    expect((await fetch("/api/availability?from=2026-09-01&to=2026-12-31")).status).toBe(400);
    expect((await fetch("/api/availability")).status).toBe(400);
  });
});

const good = {
  sizeId: "bouquet", date: "2026-09-09", fulfillment: "pickup",
  customer: { name: "Pat Lee", email: "pat@example.com", phone: "518-555-0100" }, note: "yellows please",
};
const post = (fetch: any, body: unknown) =>
  fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/checkout", () => {
  it("holds a slot, creates a session with correct line items, returns the url", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, good);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://checkout.example/1" });
    const c = payments.created[0];
    expect(c.lineItems).toEqual([{ name: "Bouquet — pickup Wed Sep 9", amountCents: 8500, quantity: 1 }]);
    expect(c.expiresAt).toBe(Math.floor(new Date("2026-09-08T14:31:00Z").getTime() / 1000));
    expect(c.successUrl).toBe(`https://thebullandbloom.com/thanks?order=${c.orderId}`);
    const row = await env.DB.prepare("SELECT status, stripe_session_id, note, hold_expires_at FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ status: "held", stripe_session_id: "cs_1", note: "yellows please", hold_expires_at: c.expiresAt + 120 });
  });
  it("returns 409 sold_out when the day is full and does not call Stripe", async () => {
    await seedAdminOverride("2026-09-16", 1, false);
    const { fetch, payments } = testApp();
    expect((await post(fetch, { ...good, date: "2026-09-16" })).status).toBe(200);
    const r = await post(fetch, { ...good, date: "2026-09-16" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "sold_out" });
    expect(payments.created.length).toBe(1);
  });
  it("rejects a same-day order after the cutoff", async () => {
    const { fetch } = testApp(new Date("2026-09-08T16:00:00Z")); // 12:00 EDT
    const r = await post(fetch, { ...good, date: "2026-09-08" });
    expect(r.status).toBe(409);
  });
  it("validates input", async () => {
    const { fetch } = testApp();
    expect((await post(fetch, { ...good, sizeId: "giant" })).status).toBe(400);
    expect((await post(fetch, { ...good, fulfillment: "delivery" })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "", email: "pat@example.com" } })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "Pat", email: "not-an-email" } })).status).toBe(400);
    expect((await post(fetch, { ...good, note: "x".repeat(501) })).status).toBe(400);
    expect((await fetch("/api/checkout", { method: "POST", body: "not json" })).status).toBe(400);
  });
  it("accepts a customer name that only exceeds 120 characters before trimming", async () => {
    const { fetch } = testApp();
    const name = `${" ".repeat(5)}${"a".repeat(118)}${" ".repeat(5)}`; // 128 raw, trims to 118
    const r = await post(fetch, { ...good, date: "2026-09-19", customer: { ...good.customer, name } });
    expect(r.status).toBe(200);
  });
  it("releases the hold and returns 503 if Stripe fails", async () => {
    const { fetch, payments } = testApp();
    payments.failNext = true;
    const r = await post(fetch, { ...good, date: "2026-09-17" });
    expect(r.status).toBe(503);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE date = '2026-09-17' AND status = 'held'").first<any>();
    expect(n.n).toBe(0);
  });
  it("releases the hold and returns 503 if attaching the session fails after Stripe succeeds", async () => {
    const { fetch, payments } = testApp();
    const nextId = peekNextSessionId();
    // Pre-insert a held order whose stripe_session_id is the id the fake will
    // hand out next, so attachSession's UPDATE trips the UNIQUE constraint.
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id)
       VALUES ('preexisting-session', 0, 'held', '2020-01-01', 'bouquet', 'pickup', 'X', 'x@example.com', 8500, ?)`,
    ).bind(nextId).run();
    const r = await post(fetch, { ...good, date: "2026-09-22" }); // Tuesday: open weekday
    expect(r.status).toBe(503);
    expect(payments.created.length).toBe(1);
    const row = await env.DB.prepare("SELECT status FROM orders WHERE date = '2026-09-22'").first<any>();
    expect(row.status).toBe("cancelled");
  });
});
