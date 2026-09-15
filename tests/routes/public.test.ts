import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { testApp, seedAdminOverride, peekNextSessionId } from "../helpers";
import { loadConfig } from "../../src/config";

describe("GET /api/config", () => {
  it("returns sizes and timezone without the studio address", async () => {
    const { fetch } = testApp();
    const r = await fetch("/api/config");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.timezone).toBe("America/New_York");
    expect(body.sizes[0]).toHaveProperty("priceCents");
    expect(body.sizes[0]).toHaveProperty("vaseFeeCents");
    expect(JSON.stringify(body)).not.toContain("pickupAddress");
    expect(body.delivery).toEqual({ offered: true });
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
  it("rejects a date far beyond the ordering horizon", async () => {
    const { fetch } = testApp();
    const r = await post(fetch, { ...good, date: "2099-06-15" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "date too far ahead" });
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

// The zip comes from the repo config so the "listed zip" tests follow whatever fallback list is configured.
const LISTED_ZIP = loadConfig().delivery.fallbackZips[0];
const address = { street: "5 Elm Street", unit: "", city: "Albany", state: "NY", zip: LISTED_ZIP };
const outside = { ...address, zip: "10001" };
const quoteFor = (fetch: any, body: unknown) =>
  fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/quote", () => {
  it("prices a delivery from Uber, scheduled for the studio ready time on the order date", async () => {
    const { fetch, uber } = testApp();
    uber.quoteFee = 1350;
    const r = await quoteFor(fetch, { date: "2026-09-16", address });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body).toMatchObject({ available: true, feeCents: 1350, kind: "uber", estimate: false });
    expect(typeof body.quoteToken).toBe("string");
    // 09:00 America/New_York on 2026-09-16 == 13:00 UTC
    expect(uber.quoted[0].window.pickupReadyAt.toISOString()).toBe("2026-09-16T13:00:00.000Z");
    expect(uber.quoted[0].dropoff.address.zip).toBe(LISTED_ZIP);
    expect(uber.quoted[0].valueCents).toBeGreaterThan(0);
  });

  it("marks the fee as an estimate when the date is past Uber's 30-day scheduling window (D32)", async () => {
    // testApp()'s clock is 2026-09-08T14:00:00Z; 2026-10-18 is ~40 days out, past
    // MAX_SCHEDULE_DAYS, so pickupReadyFor degrades to ASAP and the quote must say so.
    const now = new Date("2026-09-08T14:00:00Z");
    const { fetch, uber } = testApp(now);
    const r = await quoteFor(fetch, { date: "2026-10-18", address });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body).toMatchObject({ available: true, kind: "uber", estimate: true });
    // ASAP: priced for right now, not for the studio's ready time on 2026-10-18.
    expect(Math.abs(+uber.quoted[0].window.pickupReadyAt - +now)).toBeLessThan(60_000);
  });

  it("offers the flat fallback fee for a listed zip when Uber says the address is undeliverable", async () => {
    const { fetch, uber } = testApp();
    uber.failWith("undeliverable", "not in a deliverable area");
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address })).json() as any;
    expect(body).toMatchObject({ available: true, kind: "fallback", estimate: false });
    expect(body.feeCents).toBe(loadConfig().delivery.fallbackFeeCents);
  });

  it("offers the fallback when Uber is not configured at all", async () => {
    const { fetch, uber } = testApp();
    uber.isConfigured = false;
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address })).json() as any;
    expect(body).toMatchObject({ available: true, kind: "fallback" });
    expect(uber.quoted).toHaveLength(0);
  });

  it("says outside_area when Uber refuses and the zip is not on the fallback list", async () => {
    const { fetch, uber } = testApp();
    uber.failWith("undeliverable", "nope");
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address: outside })).json() as any;
    expect(body).toEqual({ available: false, reason: "outside_area" });
  });

  it("says unavailable when Uber breaks and there is no fallback for the zip", async () => {
    const { fetch, uber } = testApp();
    uber.failWith("unavailable", "uber 500");
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address: outside })).json() as any;
    expect(body).toEqual({ available: false, reason: "unavailable" });
  });

  it("validates the date and the address", async () => {
    const { fetch } = testApp();
    expect((await quoteFor(fetch, { date: "nope", address })).status).toBe(400);
    expect((await quoteFor(fetch, { date: "2026-09-16", address: { ...address, zip: "abc" } })).status).toBe(400);
    expect((await quoteFor(fetch, { date: "2099-01-01", address })).status).toBe(400);
    expect((await fetch("/api/quote", { method: "POST", body: "not json" })).status).toBe(400);
  });
});

async function deliveryBody(fetch: any, over: Record<string, unknown> = {}) {
  const q = await (await fetch("/api/quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-09-23", address }),
  })).json() as any;
  return {
    sizeId: "bouquet", date: "2026-09-23", fulfillment: "delivery",
    customer: { name: "Pat Lee", email: "pat@example.com", phone: "(518) 555-0100" },
    note: "yellows please",
    delivery: { address, notes: "porch, behind the planter", quoteToken: q.quoteToken },
    ...over,
  };
}

describe("POST /api/checkout — delivery", () => {
  it("locks the quoted fee on the order, stores the address, and adds a Delivery line item", async () => {
    const { fetch, payments, uber } = testApp();
    uber.quoteFee = 1350;
    const r = await post(fetch, await deliveryBody(fetch));
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems).toEqual([
      { name: "Bouquet — delivery Wed Sep 23", amountCents: 8500, quantity: 1 },
      { name: "Delivery — Wed Sep 23", amountCents: 1350, quantity: 1 },
    ]);
    const row = await env.DB.prepare(
      "SELECT fulfillment, delivery_cents, uber_quote_id, customer_phone, address_json FROM orders WHERE id = ?",
    ).bind(c.orderId).first<any>();
    expect(row.fulfillment).toBe("delivery");
    expect(row.delivery_cents).toBe(1350);
    expect(row.uber_quote_id).toBe("dqt_fake_1");
    expect(row.customer_phone).toBe("+15185550100");
    expect(JSON.parse(row.address_json)).toEqual({
      street: "5 Elm Street", unit: "", city: "Albany", state: "NY", zip: LISTED_ZIP,
      notes: "porch, behind the planter",
    });
  });

  it("refuses a delivery order with no phone", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch, { customer: { name: "Pat Lee", email: "pat@example.com" } });
    const r = await post(fetch, body);
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/phone/);
  });

  it("refuses a phone it cannot dial", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch, { customer: { name: "Pat Lee", email: "pat@example.com", phone: "call me" } });
    expect((await post(fetch, body)).status).toBe(400);
  });

  it("refuses a fee the browser edited: the token, not the body, carries the price", async () => {
    const { fetch, payments } = testApp();
    const body = await deliveryBody(fetch);
    const before = payments.created.length;
    const r = await post(fetch, { ...body, deliveryCents: 1, delivery: { ...(body as any).delivery, feeCents: 1 } });
    // The extra fields are simply ignored; the order is created at the signed fee.
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(payments.created.length).toBe(before + 1);
    expect(c.lineItems[1].amountCents).toBe(1200);
  });

  it("rejects a quote for a different address or a different day", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch);
    expect((await post(fetch, { ...body, date: "2026-09-24" })).status).toBe(409);
    const moved = { ...(body as any).delivery, address: { ...address, street: "9 Oak Street" } };
    expect((await post(fetch, { ...body, delivery: moved })).status).toBe(409);
  });

  it("rejects a forged or expired token with quote_expired", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch);
    const r = await post(fetch, { ...body, delivery: { ...(body as any).delivery, quoteToken: "forged.token" } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "quote_expired" });
  });

  it("still accepts a pickup order with no delivery block, unchanged from Plan 1", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, { ...good, date: "2026-09-25" });
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems).toEqual([{ name: "Bouquet — pickup Fri Sep 25", amountCents: 8500, quantity: 1 }]);
    const row = await env.DB.prepare("SELECT delivery_cents, address_json FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ delivery_cents: 0, address_json: null });
  });
});

describe("POST /api/checkout — presentation", () => {
  const vaseFee = () => loadConfig().sizes.find((s) => s.id === "bouquet")!.vaseFeeCents;
  it("adds a Vase line item and stores the choice", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, { ...good, date: "2026-09-29", presentation: "vase" });
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems).toEqual([
      { name: "Bouquet — pickup Tue Sep 29", amountCents: 8500, quantity: 1 },
      { name: "Vase", amountCents: vaseFee(), quantity: 1 },
    ]);
    const row = await env.DB.prepare("SELECT presentation, vase_cents FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ presentation: "vase", vase_cents: vaseFee() });
  });
  it("defaults to hand-tied when the field is missing", async () => {
    const { fetch, payments } = testApp();
    expect((await post(fetch, { ...good, date: "2026-09-30" })).status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems.map((li) => li.name)).toEqual(["Bouquet — pickup Wed Sep 30"]);
    const row = await env.DB.prepare("SELECT presentation, vase_cents FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ presentation: "hand-tied", vase_cents: 0 });
  });
  it("rejects an unknown presentation", async () => {
    const { fetch } = testApp();
    const r = await post(fetch, { ...good, presentation: "bowl" });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/presentation/);
  });
  it("puts the Vase line between the bouquet and the delivery fee", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, await deliveryBody(fetch, { presentation: "vase" }));
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems.map((li) => li.name)).toEqual(["Bouquet — delivery Wed Sep 23", "Vase", "Delivery — Wed Sep 23"]);
  });
});
