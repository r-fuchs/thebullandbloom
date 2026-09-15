import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  tryInsertHeldOrder, countUsed, attachSession, getOrder, markPaidBySession, setCalendarEventId,
  cancelHeldBySession, expireHolds, listOrders, setStatus, markDoneIfPaid, type NewOrder,
} from "../../src/store/orders";

let n = 0;
function fresh(date = "2026-09-10"): NewOrder {
  n += 1;
  return {
    id: `o${n}`, date, sizeId: "bouquet", fulfillment: "pickup",
    customerName: "Pat", customerEmail: "pat@example.com", customerPhone: null, addressJson: null, note: null,
    bouquetCents: 8500, deliveryCents: 0, uberQuoteId: null,
    presentation: "hand-tied", vaseCents: 0,
  };
}
const NOW = 1_800_000_000;

describe("orders", () => {
  it("inserts while under cap, refuses at cap", async () => {
    expect(await tryInsertHeldOrder(env.DB, fresh("2026-09-20"), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldOrder(env.DB, fresh("2026-09-20"), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldOrder(env.DB, fresh("2026-09-20"), 2, NOW, NOW + 1800)).toBe(false);
    expect((await countUsed(env.DB, "2026-09-20", "2026-09-20")).get("2026-09-20")).toBe(2);
  });
  it("done orders still count and still block at cap (D15)", async () => {
    const a = fresh("2026-09-26");
    await tryInsertHeldOrder(env.DB, a, 1, NOW, NOW + 1800);
    await setStatus(env.DB, a.id, "done");
    expect((await countUsed(env.DB, "2026-09-26", "2026-09-26")).get("2026-09-26")).toBe(1);
    expect(await tryInsertHeldOrder(env.DB, fresh("2026-09-26"), 1, NOW, NOW + 1800)).toBe(false);
  });
  it("cancelled orders do not count; subscription orders do not count", async () => {
    const a = fresh("2026-09-21");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await setStatus(env.DB, a.id, "cancelled");
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, source)
       VALUES ('sub1', ?, 'paid', '2026-09-21', 'bouquet', 'pickup', 'S', 's@example.com', 8500, 'subscription')`,
    ).bind(NOW).run();
    expect((await countUsed(env.DB, "2026-09-21", "2026-09-21")).get("2026-09-21") ?? 0).toBe(0);
  });
  it("attaches a session, marks paid once, ignores a second completion", async () => {
    const a = fresh("2026-09-22");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_1");
    const paid = await markPaidBySession(env.DB, "cs_1", "pi_1");
    expect(paid?.status).toBe("paid");
    expect(paid?.holdExpiresAt).toBeNull();
    expect(await markPaidBySession(env.DB, "cs_1", "pi_1")).toBeNull();
    expect((await getOrder(env.DB, a.id))?.stripePaymentIntent).toBe("pi_1");
  });
  it("cancels a held order by session but never a paid one", async () => {
    const a = fresh("2026-09-23");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_2");
    await markPaidBySession(env.DB, "cs_2", "pi_2");
    expect(await cancelHeldBySession(env.DB, "cs_2")).toBe(false);
    const b = fresh("2026-09-23");
    await tryInsertHeldOrder(env.DB, b, 5, NOW, NOW + 1800);
    await attachSession(env.DB, b.id, "cs_3");
    expect(await cancelHeldBySession(env.DB, "cs_3")).toBe(true);
    expect((await getOrder(env.DB, b.id))?.status).toBe("cancelled");
  });
  it("expires holds past their deadline only", async () => {
    const a = fresh("2026-09-24"), b = fresh("2026-09-24");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 100);
    await tryInsertHeldOrder(env.DB, b, 5, NOW, NOW + 5000);
    expect(await expireHolds(env.DB, NOW + 200)).toBe(1);
    expect((await getOrder(env.DB, a.id))?.status).toBe("cancelled");
    expect((await getOrder(env.DB, b.id))?.status).toBe("held");
  });
  it("lists a day's orders oldest first", async () => {
    const a = fresh("2026-09-25"), b = fresh("2026-09-25");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await tryInsertHeldOrder(env.DB, b, 5, NOW + 1, NOW + 1800);
    expect((await listOrders(env.DB, "2026-09-25")).map((o) => o.id)).toEqual([a.id, b.id]);
  });
  it("stores an address and quote id on a delivery order", async () => {
    const ok = await tryInsertHeldOrder(env.DB, {
      id: "ord-delivery", date: "2026-10-06", sizeId: "bouquet", fulfillment: "delivery",
      customerName: "Pat", customerEmail: "pat@example.com", customerPhone: "+15185550100",
      addressJson: JSON.stringify({ street: "5 Elm St", unit: "", city: "Hudson", state: "NY", zip: "12534", notes: "porch" }),
      note: null, bouquetCents: 8500, deliveryCents: 1200, uberQuoteId: "dqt_abc",
      presentation: "hand-tied", vaseCents: 0,
    }, 4, 1000, 2000);
    expect(ok).toBe(true);
    const o = (await getOrder(env.DB, "ord-delivery"))!;
    expect(o.fulfillment).toBe("delivery");
    expect(o.deliveryCents).toBe(1200);
    expect(o.uberQuoteId).toBe("dqt_abc");
    expect(JSON.parse(o.addressJson!).zip).toBe("12534");
  });
  it("stores the presentation and vase cents", async () => {
    const o = { ...fresh("2026-09-27"), presentation: "vase" as const, vaseCents: 2000 };
    expect(await tryInsertHeldOrder(env.DB, o, 5, NOW, NOW + 1800)).toBe(true);
    const got = await getOrder(env.DB, o.id);
    expect(got).toMatchObject({ presentation: "vase", vaseCents: 2000 });
    const plain = await getOrder(env.DB, (await (async () => { const p = fresh("2026-09-27"); await tryInsertHeldOrder(env.DB, p, 5, NOW, NOW + 1800); return p; })()).id);
    expect(plain).toMatchObject({ presentation: "hand-tied", vaseCents: 0 });
  });
});

describe("markPaidBySession extras and calendar id", () => {
  it("runs extra statements in the same batch as the flip", async () => {
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id, hold_expires_at)
       VALUES ('px1', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, 'cs_px1', 99)`,
    ).run();
    const marker = env.DB.prepare("INSERT INTO settings (key, value_json) VALUES ('test.px1', '1')");
    const o = await markPaidBySession(env.DB, "cs_px1", "pi_px1", [marker]);
    expect(o?.status).toBe("paid");
    expect(await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'test.px1'").first()).toEqual({ value_json: "1" });
    await env.DB.prepare("DELETE FROM settings WHERE key = 'test.px1'").run();
    // a duplicate flip changes nothing and returns null; callers guard their extras (outbox uses INSERT OR IGNORE + a status check)
    expect(await markPaidBySession(env.DB, "cs_px1", "pi_px1")).toBeNull();
  });
  it("stores the calendar event id", async () => {
    await setCalendarEventId(env.DB, "px1", "bbpx1");
    expect((await getOrder(env.DB, "px1"))?.calendarEventId).toBe("bbpx1");
  });
});

describe("markDoneIfPaid", () => {
  it("marks an order done only from paid", async () => {
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents)
       VALUES ('md1', 1, 'paid', '2026-10-07', 'bouquet', 'delivery', 'A', 'a@example.com', 8500),
              ('md2', 1, 'refunded', '2026-10-07', 'bouquet', 'delivery', 'B', 'b@example.com', 8500)`,
    ).run();
    expect(await markDoneIfPaid(env.DB, "md1")).toBe(true);
    expect(await markDoneIfPaid(env.DB, "md1")).toBe(false);
    expect(await markDoneIfPaid(env.DB, "md2")).toBe(false);
    expect((await getOrder(env.DB, "md2"))!.status).toBe("refunded");
  });
});
