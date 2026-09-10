import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp } from "../helpers";
import { saveState, clearConnection } from "../../src/store/google";
import { counts } from "../../src/store/outbox";
import { byStripeSubscription, getSubscriber, insertSubscriber } from "../../src/store/subscribers";
import { mirrorStatus } from "../../src/routes/webhooks";

const NOW = new Date("2026-09-10T14:00:00Z");
const STATE = { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 };
const hook = (fetch: any) => fetch("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": "good" }, body: "{}" });
const post = (fetch: any, body: unknown) => fetch("/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const good = { sizeId: "bouquet", cadenceId: "weekly", weekday: 2, customer: { name: "Pat Smith", email: "pat@example.com", phone: "518-555-0100" }, note: "no lilies" };
const dates = async (id: string) => (await env.DB.prepare("SELECT date FROM orders WHERE subscriber_id = ? ORDER BY date").bind(id).all<any>()).results.map((r) => r.date);
async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string) => fetch(path, { headers: { cookie } });
}

describe("subscriptions: signup, webhooks, admin", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM orders WHERE subscriber_id IS NOT NULL").run();
    await env.DB.prepare("DELETE FROM subscribers").run();
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM settings").run();
    await clearConnection(env.DB);
  });

  it("exposes the grid and open weekdays on /api/config", async () => {
    const { fetch } = testApp(NOW);
    const cfg = await (await fetch("/api/config")).json();
    expect(cfg.subscriptions.cadences.map((c: any) => c.id)).toEqual(["weekly", "twice-monthly"]);
    expect(cfg.subscriptions.cells).toHaveLength(6);
    expect(cfg.openWeekdays).toEqual([2, 3, 4, 5, 6]);
  });

  it("validates a signup and creates a subscription checkout with the choice in metadata", async () => {
    const { fetch, payments } = testApp(NOW);
    expect((await post(fetch, { ...good, cadenceId: "nope" })).status).toBe(400);
    expect((await post(fetch, { ...good, weekday: 1 })).status).toBe(400); // Monday closed
    expect((await post(fetch, { ...good, customer: { name: "", email: "pat@example.com" } })).status).toBe(400);
    const r = await post(fetch, good);
    expect(r.status).toBe(200);
    expect((await r.json()).url).toMatch(/^https:\/\/checkout\.example\//);
    expect(payments.createdSubscriptions).toHaveLength(1);
    expect(payments.createdSubscriptions[0]).toMatchObject({
      customerEmail: "pat@example.com", productName: "Bouquet · every week", amountCents: 29000,
      metadata: { cell: "bouquet/weekly", weekday: "2", name: "Pat Smith", phone: "518-555-0100", note: "no lilies" },
      successUrl: `${env.SITE_URL}/thanks?subscription=1`, cancelUrl: `${env.SITE_URL}/#subscribe`,
    });
    payments.failNext = true;
    expect((await post(fetch, good)).status).toBe(503);
  });

  it("subscription.started creates the subscriber, three bouquets, two emails; replay is ignored", async () => {
    await saveState(env.DB, STATE);
    const { fetch, payments, google } = testApp(NOW);
    payments.nextEvent = { type: "subscription.started", sessionId: "cs_s1", customerId: "cus_1", subscriptionId: "sub_1",
      customerEmail: "pat@example.com", metadata: { cell: "bouquet/weekly", weekday: "2", name: "Pat Smith", phone: "518-555-0100", note: "no lilies" } };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "subscribed" });
    const sub = await byStripeSubscription(env.DB, "sub_1");
    expect(sub).toMatchObject({ status: "active", anchorDate: "2026-09-15", customerName: "Pat Smith", customerPhone: "518-555-0100", note: "no lilies" });
    expect(await dates(sub!.id)).toEqual(["2026-09-15", "2026-09-22", "2026-09-29"]);
    // background drain ran inline in tests: 3 events + 2 emails delivered
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    expect(google.inserted.map((i) => i.event.summary)).toEqual(Array(3).fill("Bouquet · Pat Smith · pickup (subscription)"));
    expect(google.sent.map((m) => m.subject)).toEqual([
      "Your Bull and Bloom subscription starts Tue Sep 15",
      "New subscription: Bouquet every week · Pat Smith · Tuesdays",
    ]);
    expect(google.sent[0].text).toContain("https://billing.example/cus_1");
    expect(payments.portals).toEqual([{ customerId: "cus_1", returnUrl: `${env.SITE_URL}/` }]);
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers").first<any>()).n).toBe(1);
  });

  it("ignores subscription.started with unusable metadata", async () => {
    const { fetch, payments } = testApp(NOW);
    payments.nextEvent = { type: "subscription.started", sessionId: "cs_x", customerId: "cus_x", subscriptionId: "sub_x", customerEmail: "x@example.com", metadata: { cell: "nope/weekly", weekday: "2" } };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
    expect(await byStripeSubscription(env.DB, "sub_x")).toBeNull();
  });

  it("mirrors Stripe status: pause clears future bouquets, resume restores them, cancel keeps this week and emails", async () => {
    await saveState(env.DB, STATE);
    const { fetch, payments, google } = testApp(NOW);
    await insertSubscriber(env.DB, { id: "w1", stripeCustomerId: "cus_w", stripeSubscriptionId: "sub_w", sizeId: "posy", cadenceId: "weekly", weekday: 4,
      fulfillment: "pickup", addressJson: null, deliveryAddOnCents: 0, anchorDate: "2026-09-10", customerName: "Sam Lee", customerEmail: "sam@example.com", customerPhone: null, note: null }, 1);
    payments.nextEvent = { type: "subscription.updated", subscriptionId: "sub_w", status: "active", paused: false };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" }); // already active
    // materialize as the cron would
    await fetch("/api/health"); // no-op; keep app warm
    const { materializeSubscriptions } = await import("../../src/jobs/materialize");
    await materializeSubscriptions({ db: env.DB, config: (await import("../../src/config")).loadConfig() }, NOW);
    expect(await dates("w1")).toEqual(["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"]);

    payments.nextEvent = { type: "subscription.updated", subscriptionId: "sub_w", status: "active", paused: true };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paused" });
    expect(await dates("w1")).toEqual(["2026-09-10"]); // today's stays, later ones go
    expect((await getSubscriber(env.DB, "w1"))!.status).toBe("paused");

    payments.nextEvent = { type: "subscription.updated", subscriptionId: "sub_w", status: "active", paused: false };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "active" });
    expect(await dates("w1")).toEqual(["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"]);

    google.sent.length = 0;
    payments.nextEvent = { type: "subscription.deleted", subscriptionId: "sub_w" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "cancelled" });
    expect(await dates("w1")).toEqual(["2026-09-10"]); // Sep 10 is this week (Mon 7–Sun 13); Sep 17 onward removed
    expect(google.sent.map((m) => m.subject)).toEqual(["Your Bull and Bloom subscription has ended", "Subscription cancelled: Posy every week · Sam Lee"]);
    payments.nextEvent = { type: "subscription.deleted", subscriptionId: "sub_unknown" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
  });

  it("maps Stripe statuses", () => {
    expect(mirrorStatus("active", false)).toBe("active");
    expect(mirrorStatus("active", true)).toBe("paused");
    expect(mirrorStatus("past_due", false)).toBe("paused");
    expect(mirrorStatus("canceled", false)).toBe("cancelled");
    expect(mirrorStatus("incomplete", false)).toBeNull();
  });

  it("admin lists subscribers with their next bouquet and any skipped-week flags", async () => {
    const { fetch } = testApp(NOW);
    await insertSubscriber(env.DB, { id: "a1", stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a", sizeId: "statement", cadenceId: "twice-monthly", weekday: 5,
      fulfillment: "pickup", addressJson: null, deliveryAddOnCents: 0, anchorDate: "2026-09-04", customerName: "Ann", customerEmail: "ann@example.com", customerPhone: null, note: null }, 1);
    expect((await fetch("/admin/api/subscribers")).status).toBe(401);
    const api = await login(fetch);
    const body = await (await api("/admin/api/subscribers")).json();
    expect(body.subscribers).toHaveLength(1);
    expect(body.subscribers[0]).toMatchObject({ id: "a1", status: "active", cadenceName: "Twice a month", weekday: 5, nextDate: "2026-09-18" });
    expect(body.flags).toEqual([]);
  });
});
