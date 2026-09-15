import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp } from "../helpers";
import { saveState, clearConnection } from "../../src/store/google";
import { insertDelivery, applyStatus } from "../../src/store/deliveries";
import { loadConfig } from "../../src/config";

async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  expect(r.status).toBe(204);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" } });
}

const ADDRESS = '{"street":"5 Elm Street","unit":"Apt 2","city":"Hudson","state":"NY","zip":"12534","notes":"porch"}';

async function order(id: string, over: Partial<{ status: string; fulfillment: string; phone: string | null; address: string | null; deliveryCents: number; presentation: string; vaseCents: number }> = {}) {
  const o = { status: "paid", fulfillment: "delivery", phone: "+15185550100", address: ADDRESS, deliveryCents: 1200, presentation: "hand-tied", vaseCents: 0, ...over };
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, bouquet_cents, delivery_cents, presentation, vase_cents)
     VALUES (?, 1, ?, '2026-09-23', 'bouquet', ?, 'Pat Smith', 'pat@example.com', ?, ?, 8500, ?, ?, ?)`,
  ).bind(id, o.status, o.fulfillment, o.phone, o.address, o.deliveryCents, o.presentation, o.vaseCents).run();
}

describe("POST /admin/api/orders/:id/dispatch", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM orders").run();
    await clearConnection(env.DB);
  });

  it("refuses without a session", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/orders/x/dispatch", { method: "POST" })).status).toBe(401);
  });

  it("gets a fresh quote for right now, creates the delivery, stores it, and queues the tracking email", async () => {
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    await order("d1");
    const { fetch, uber, google } = testApp(new Date("2026-09-23T15:00:00Z"));
    uber.quoteFee = 1450;
    const as = await login(fetch);
    const r = await as("/admin/api/orders/d1/dispatch", { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.delivery).toMatchObject({ status: "pending", feeCents: 1450, trackingUrl: "https://track.uber.test/del_fake_2" });
    expect(body.variance).toEqual({ deliveries: 1, varianceCents: 250 });

    // the day-of quote asks for a pickup now, not at the studio's morning ready time
    expect(+uber.quoted[0].window.pickupReadyAt).toBe(+new Date("2026-09-23T15:00:00Z"));
    // the real customer phone and the real order value go on the delivery
    expect(uber.created[0].dropoff.phone).toBe("+15185550100");
    expect(uber.created[0].dropoff.notes).toBe("porch");
    expect(uber.created[0].dropoff.address.zip).toBe("12534");
    expect(uber.created[0].valueCents).toBe(8500);
    expect(uber.created[0].itemName).toBe("Bouquet — hand-tied flowers");
    expect(uber.created[0].quoteId).toBe("dqt_fake_1");
    expect(uber.created[0].idempotencyKey).toContain("d1");

    const row = await env.DB.prepare("SELECT order_id, uber_delivery_id, status, quoted_cents, fee_cents FROM deliveries").first<any>();
    expect(row).toEqual({ order_id: "d1", uber_delivery_id: "del_fake_2", status: "pending", quoted_cents: 1450, fee_cents: 1450 });

    // the tracking email went out on the same request (Google is connected)
    expect(google.sent.map((m) => m.subject)).toContain("Your Bull and Bloom bouquet is on the way");
  });

  it("queues the email but still succeeds when Google is not connected", async () => {
    await order("d2");
    const { fetch, google } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d2/dispatch", { method: "POST" })).status).toBe(200);
    expect(google.sent).toHaveLength(0);
    const box = await env.DB.prepare("SELECT kind, done_at FROM outbox WHERE order_id = 'd2'").first<any>();
    expect(box).toEqual({ kind: "courier_email", done_at: null });
  });

  it("refuses a pickup order, a non-paid order, and an unknown order", async () => {
    await order("d3", { fulfillment: "pickup", address: null });
    await order("d4", { status: "held" });
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d3/dispatch", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/d4/dispatch", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/nope/dispatch", { method: "POST" })).status).toBe(404);
  });

  it("stores a known status when Uber reports one it does not model, rather than freezing the row", async () => {
    await order("d5b");
    const { fetch, uber } = testApp();
    uber.nextStatus = "teleported";
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d5b/dispatch", { method: "POST" })).status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM deliveries WHERE order_id = 'd5b'").first<any>();
    expect(row.status).toBe("pending");
  });

  it("refuses a second courier while one is live, and allows one after a cancellation", async () => {
    await order("d5");
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d5/dispatch", { method: "POST" })).status).toBe(200);
    const dup = await as("/admin/api/orders/d5/dispatch", { method: "POST" });
    expect(dup.status).toBe(409);
    expect((await dup.json() as any).error).toBe("courier_already_requested");
    await applyStatus(env.DB, "del_fake_2", "canceled", "courier cancelled", 5000);
    expect((await as("/admin/api/orders/d5/dispatch", { method: "POST" })).status).toBe(200);
  });

  it("leaves the order paid and reports the reason when Uber fails, so Anthony can retry or drive", async () => {
    await order("d6");
    const { fetch, uber } = testApp();
    const as = await login(fetch);
    uber.failWith("unavailable", "uber /deliveries 500: boom");
    const r = await as("/admin/api/orders/d6/dispatch", { method: "POST" });
    expect(r.status).toBe(502);
    expect((await r.json() as any).message).toContain("boom");
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'd6'").first<any>()).status).toBe("paid");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries").first<any>()).n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<any>()).n).toBe(0);
  });

  it("says so plainly when Uber is not set up on this deployment", async () => {
    await order("d7");
    const { fetch, uber } = testApp();
    uber.isConfigured = false;
    const as = await login(fetch);
    const r = await as("/admin/api/orders/d7/dispatch", { method: "POST" });
    expect(r.status).toBe(503);
    expect((await r.json() as any).error).toBe("uber_not_configured");
  });

  it("tells the courier it is a vase and declares the vase in the parcel value", async () => {
    await order("d7", { presentation: "vase", vaseCents: 2000 });
    const { fetch, uber } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d7/dispatch", { method: "POST" })).status).toBe(200);
    expect(uber.created[uber.created.length - 1].itemName).toBe("Bouquet — flowers in a vase");
    expect(uber.created[uber.created.length - 1].valueCents).toBe(10500);
  });

  it("refuses an order whose address or phone the courier could not use", async () => {
    await order("d8", { address: null });
    await order("d9", { phone: null });
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d8/dispatch", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/d9/dispatch", { method: "POST" })).status).toBe(409);
  });

  it("reports a booked courier when the record fails to save, so Anthony knows to retry rather than drive blind", async () => {
    await order("d10");
    const { fetch, uber } = testApp();
    const as = await login(fetch);
    // Force just the batch write to fail, deterministically, after Uber has already accepted
    // the job — dropping `deliveries` itself would also break the earlier activeDeliveryFor()
    // check the route makes before ever calling Uber, which is a different (already-covered)
    // path. Dropping `outbox` instead only breaks the batch's second statement. Without
    // poisoning later tests: the table is recreated in `finally` before this test ends, so
    // every test after it still finds `outbox` present. (D1's exec() runs one statement per
    // line, so the CREATE TABLE below must stay on a single line.)
    await env.DB.exec("DROP TABLE outbox");
    try {
      const r = await as("/admin/api/orders/d10/dispatch", { method: "POST" });
      expect(r.status).toBe(500);
      const body = await r.json() as any;
      expect(body.error).toBe("record_not_saved");
      expect(body.delivery.id).toBe("del_fake_2");
      expect(body.message).toContain("Press Request courier again");
      expect(uber.created.length).toBe(1);
      const o = await env.DB.prepare("SELECT status FROM orders WHERE id = 'd10'").first<any>();
      expect(o.status).toBe("paid");
      // the batch is atomic: the outbox half failing means the deliveries half never landed either
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE order_id = 'd10'").first<any>();
      expect(n.n).toBe(0);
    } finally {
      await env.DB.exec(
        // the shape migration 0004 leaves behind: no kind CHECK, the drain validates kinds in code
        "CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, order_id TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT, done_at INTEGER, UNIQUE (order_id, kind))",
      );
      await env.DB.exec("CREATE INDEX outbox_due ON outbox (done_at, next_attempt_at)");
    }
  });
});

describe("GET /admin/api/delivery/status", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
  });

  it("reports whether Uber is set up, the fallback, and the running variance", async () => {
    await order("s1");
    await insertDelivery(env.DB, {
      id: "row1", orderId: "s1", uberDeliveryId: "u_s1", status: "delivered",
      quotedCents: 1500, feeCents: 1500, trackingUrl: "https://t.test/1", at: 10,
    });
    const { fetch } = testApp();
    const as = await login(fetch);
    const body = await (await as("/admin/api/delivery/status")).json() as any;
    expect(body.configured).toBe(true);
    expect(body.fallbackFeeCents).toBeGreaterThan(0);
    expect(Array.isArray(body.fallbackZips)).toBe(true);
    expect(body.variance).toEqual({ deliveries: 1, varianceCents: 300 });
  });
});

describe("GET /admin/api/orders with deliveries", () => {
  it("returns the delivery beside its order so the day panel can show a tracking link", async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
    await order("o1");
    await insertDelivery(env.DB, {
      id: "row2", orderId: "o1", uberDeliveryId: "u_o1", status: "dropoff",
      quotedCents: 1200, feeCents: 1200, trackingUrl: "https://t.test/2", at: 10,
    });
    const { fetch } = testApp();
    const as = await login(fetch);
    const body = await (await as("/admin/api/orders?date=2026-09-23")).json() as any;
    expect(body.orders.map((o: any) => o.id)).toContain("o1");
    expect(body.deliveries.o1).toMatchObject({ status: "dropoff", trackingUrl: "https://t.test/2", feeCents: 1200 });
  });
});

describe("GET /admin/api/delivery/status", () => {
  it("reports the configured delivery mode alongside the fallback fee and zips", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    const body = await (await as("/admin/api/delivery/status")).json() as any;
    const cfg = loadConfig();
    expect(body).toMatchObject({ mode: cfg.delivery.mode ?? "uber", fallbackFeeCents: cfg.delivery.fallbackFeeCents, fallbackZips: cfg.delivery.fallbackZips });
  });
});
