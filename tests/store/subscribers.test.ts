import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  byStripeSubscription, deleteFutureMaterialized, getSubscriber, insertMaterializedOrder, insertSubscriber,
  listSubscribers, setPausedWeeks, setSubscriberStatus,
} from "../../src/store/subscribers";
import { countUsed } from "../../src/store/orders";

const base = {
  id: "sub_local_1", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_stripe_1", sizeId: "bouquet", cadenceId: "weekly",
  weekday: 2, fulfillment: "pickup" as const, addressJson: null, deliveryAddOnCents: 0, anchorDate: "2026-09-15",
  customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: null, note: "no lilies",
};

describe("store/subscribers", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM orders WHERE subscriber_id IS NOT NULL").run();
    await env.DB.prepare("DELETE FROM subscribers").run();
  });

  it("inserts once per Stripe subscription and reads back", async () => {
    expect(await insertSubscriber(env.DB, base, 100)).toBe(true);
    expect(await insertSubscriber(env.DB, { ...base, id: "other" }, 101)).toBe(false); // same stripe_subscription_id
    const s = await getSubscriber(env.DB, "sub_local_1");
    expect(s).toMatchObject({ id: "sub_local_1", status: "active", pausedWeeks: [], anchorDate: "2026-09-15", createdAt: 100 });
    expect((await byStripeSubscription(env.DB, "sub_stripe_1"))?.id).toBe("sub_local_1");
    expect(await byStripeSubscription(env.DB, "nope")).toBeNull();
  });

  it("lists active first, updates status and paused weeks", async () => {
    await insertSubscriber(env.DB, base, 100);
    await insertSubscriber(env.DB, { ...base, id: "s2", stripeSubscriptionId: "sub_stripe_2" }, 50);
    await setSubscriberStatus(env.DB, "s2", "cancelled");
    expect((await listSubscribers(env.DB)).map((s) => s.id)).toEqual(["sub_local_1", "s2"]);
    expect((await listSubscribers(env.DB, "active")).map((s) => s.id)).toEqual(["sub_local_1"]);
    await setPausedWeeks(env.DB, "sub_local_1", ["2026-09-21", "2026-09-14", "2026-09-21"]);
    expect((await getSubscriber(env.DB, "sub_local_1"))?.pausedWeeks).toEqual(["2026-09-14", "2026-09-21"]);
  });

  it("materializes idempotently, never counts against capacity, and deletes future rows", async () => {
    await insertSubscriber(env.DB, base, 100);
    const o = { id: "o1", subscriberId: "sub_local_1", date: "2026-09-15", sizeId: "bouquet", fulfillment: "pickup" as const,
      customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: null, addressJson: null, note: null };
    expect(await insertMaterializedOrder(env.DB, o, 200)).toBe(true);
    expect(await insertMaterializedOrder(env.DB, { ...o, id: "o1b" }, 201)).toBe(false); // same subscriber+date
    expect(await insertMaterializedOrder(env.DB, { ...o, id: "o2", date: "2026-09-22" }, 202)).toBe(true);
    expect(await insertMaterializedOrder(env.DB, { ...o, id: "o3", date: "2026-09-29" }, 203)).toBe(true);
    expect((await countUsed(env.DB, "2026-09-15", "2026-09-29")).get("2026-09-15")).toBeUndefined();
    const row = await env.DB.prepare("SELECT status, source, bouquet_cents FROM orders WHERE id = 'o1'").first<any>();
    expect(row).toEqual({ status: "paid", source: "subscription", bouquet_cents: 0 });
    // pause the week of Sep 21 only
    expect(await deleteFutureMaterialized(env.DB, "sub_local_1", "2026-09-16", "2026-09-21")).toBe(1);
    // cancel: everything after today
    expect(await deleteFutureMaterialized(env.DB, "sub_local_1", "2026-09-16")).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE subscriber_id = 'sub_local_1'").first<any>()).n).toBe(1);
  });
});
