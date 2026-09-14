import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyStatus, activeDeliveryFor, deliveriesForDate, insertDelivery, latestDeliveryFor, varianceTotal,
} from "../../src/store/deliveries";

async function order(id: string, date: string, deliveryCents: number, status = "paid") {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       bouquet_cents, delivery_cents)
     VALUES (?, 1, ?, ?, 'bouquet', 'delivery', 'Pat Smith', 'pat@example.com', 8500, ?)`,
  ).bind(id, status, date, deliveryCents).run();
}

const row = (orderId: string, uberId: string, quoted: number, fee: number) => ({
  id: `del_${uberId}`, orderId, uberDeliveryId: uberId, status: "pending" as const,
  quotedCents: quoted, feeCents: fee, trackingUrl: `https://track.uber.test/${uberId}`, at: 1000,
});

describe("store/deliveries", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
  });

  it("inserts a delivery and finds it as the active one for its order", async () => {
    await order("o1", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o1", "u1", 1300, 1300));
    const d = await activeDeliveryFor(env.DB, "o1");
    expect(d).toMatchObject({
      orderId: "o1", uberDeliveryId: "u1", status: "pending",
      quotedCents: 1300, feeCents: 1300, trackingUrl: "https://track.uber.test/u1",
      createdAt: 1000, updatedAt: 1000, lastError: null,
    });
    expect(await activeDeliveryFor(env.DB, "nope")).toBeNull();
  });

  it("stops counting a canceled or returned delivery as active, so a re-dispatch is allowed", async () => {
    await order("o3", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o3", "u3", 1300, 1300));
    await applyStatus(env.DB, "u3", "canceled", "courier could not reach the door", 2000);
    expect(await activeDeliveryFor(env.DB, "o3")).toBeNull();
    await insertDelivery(env.DB, row("o3", "u3b", 1400, 1400));
    expect((await activeDeliveryFor(env.DB, "o3"))!.uberDeliveryId).toBe("u3b");
  });

  it("applies a status update by uber delivery id and returns the row; unknown ids return null", async () => {
    await order("o4", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o4", "u4", 1300, 1300));
    const d = await applyStatus(env.DB, "u4", "pickup_complete", null, 2500);
    expect(d).toMatchObject({ orderId: "o4", status: "pickup_complete", updatedAt: 2500, lastError: null });
    expect(await applyStatus(env.DB, "unknown", "delivered", null, 2600)).toBeNull();
  });

  it("keeps a returned delivery's reason when a late, reordered dropoff arrives", async () => {
    await order("o5", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o5", "u5", 1300, 1300));
    await applyStatus(env.DB, "u5", "returned", "nobody home", 2000);
    expect((await env.DB.prepare("SELECT last_error FROM deliveries WHERE uber_delivery_id = 'u5'").first<any>()).last_error)
      .toBe("nobody home");
    // dropoff outranks nothing here — it arrived after the (higher-ranked) terminal returned event
    const d = await applyStatus(env.DB, "u5", "dropoff", null, 2100);
    expect(d).toMatchObject({ status: "returned", lastError: "nobody home" });
    const row5 = await env.DB.prepare("SELECT status, last_error FROM deliveries WHERE uber_delivery_id = 'u5'").first<any>();
    expect(row5).toEqual({ status: "returned", last_error: "nobody home" });
  });

  it("refuses to move a delivered delivery backward to pickup", async () => {
    await order("o5b", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o5b", "u5b", 1300, 1300));
    await applyStatus(env.DB, "u5b", "delivered", null, 2000);
    const d = await applyStatus(env.DB, "u5b", "pickup", null, 2100);
    expect(d).toMatchObject({ status: "delivered" });
    expect((await env.DB.prepare("SELECT status FROM deliveries WHERE uber_delivery_id = 'u5b'").first<any>()).status)
      .toBe("delivered");
  });

  it("moves a delivery stuck with an unmodeled status rather than refusing every update forever", async () => {
    await order("o5d", "2026-09-16", 1200);
    // Inserted via raw SQL: the typed insertDelivery() now refuses a status outside DeliveryStatus.
    await env.DB.prepare(
      `INSERT INTO deliveries (id, order_id, uber_delivery_id, status, quoted_cents, fee_cents, tracking_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("del_u5d", "o5d", "u5d", "teleported", 1300, 1300, "https://track.uber.test/u5d", 1000, 1000).run();
    const d = await applyStatus(env.DB, "u5d", "pickup", null, 2000);
    expect(d).toMatchObject({ status: "pickup" });
  });

  it("still moves a delivered delivery to canceled — terminal outranks delivered (a refund-and-cancel after a bad delivery)", async () => {
    await order("o5c", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o5c", "u5c", 1300, 1300));
    await applyStatus(env.DB, "u5c", "delivered", null, 2000);
    const d = await applyStatus(env.DB, "u5c", "canceled", "return requested after delivery", 2100);
    expect(d).toMatchObject({ status: "canceled", lastError: "return requested after delivery" });
  });

  it("is idempotent: replaying the same status leaves one row, the same values, and still updates updated_at", async () => {
    await order("o6", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o6", "u6", 1300, 1300));
    await applyStatus(env.DB, "u6", "delivered", null, 3000);
    const d = await applyStatus(env.DB, "u6", "delivered", null, 3100);
    expect(d).toMatchObject({ status: "delivered", updatedAt: 3100 });
    const rows = await env.DB.prepare("SELECT status, updated_at FROM deliveries WHERE uber_delivery_id = 'u6'").all<any>();
    expect(rows.results).toEqual([{ status: "delivered", updated_at: 3100 }]);
  });

  it("finds the latest delivery for an order whatever its status, and none for a stranger", async () => {
    await order("o5", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o5", "u5a", 1300, 1300));
    await applyStatus(env.DB, "u5a", "canceled", "studio cancelled", 2000);
    expect((await latestDeliveryFor(env.DB, "o5"))!.uberDeliveryId).toBe("u5a");
    await insertDelivery(env.DB, { ...row("o5", "u5b", 1300, 1300), at: 3000 });
    expect((await latestDeliveryFor(env.DB, "o5"))!.uberDeliveryId).toBe("u5b");
    expect(await latestDeliveryFor(env.DB, "nope")).toBeNull();
  });

  it("ignores a second insert of the same Uber delivery id (Uber de-duplicated a double dispatch)", async () => {
    await order("o10", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o10", "u10", 1300, 1300));
    await insertDelivery(env.DB, { ...row("o10", "u10", 1300, 1300), id: "del_u10_again" });
    const rows = await env.DB.prepare("SELECT id FROM deliveries WHERE uber_delivery_id = 'u10'").all<any>();
    expect(rows.results).toEqual([{ id: "del_u10" }]);
  });

  it("lists the deliveries for a date keyed by order id", async () => {
    await order("o7", "2026-09-17", 1200);
    await order("o8", "2026-09-17", 1200);
    await order("o9", "2026-09-18", 1200);
    await insertDelivery(env.DB, row("o7", "u7", 1300, 1300));
    await insertDelivery(env.DB, row("o9", "u9", 1300, 1300));
    const m = await deliveriesForDate(env.DB, "2026-09-17");
    expect([...m.keys()]).toEqual(["o7"]);
    expect(m.get("o7")!.uberDeliveryId).toBe("u7");
  });

  it("totals the variance Anthony absorbed, ignoring canceled jobs", async () => {
    await order("v1", "2026-09-16", 1200);
    await order("v2", "2026-09-16", 1500);
    await order("v3", "2026-09-16", 1000);
    await insertDelivery(env.DB, row("v1", "uv1", 1400, 1400));  // +200 over what the customer paid
    await insertDelivery(env.DB, row("v2", "uv2", 1300, 1300));  // -200 under
    await insertDelivery(env.DB, row("v3", "uv3", 9900, 9900));  // canceled, must not count
    await applyStatus(env.DB, "uv3", "canceled", "studio cancelled", 2000);
    expect(await varianceTotal(env.DB)).toEqual({ deliveries: 2, varianceCents: 0 });
    await insertDelivery(env.DB, row("v1", "uv1b", 1700, 1700));
    expect(await varianceTotal(env.DB)).toEqual({ deliveries: 3, varianceCents: 500 });
  });
});
