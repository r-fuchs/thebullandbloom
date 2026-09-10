import { describe, it, expect } from "vitest";
import { ownerSubscriptionEmail, subscriptionCancelledEmail, subscriptionConfirmedEmail, orderEvent } from "../../src/core/messages";
import { loadConfig } from "../../src/config";
import type { Subscriber } from "../../src/store/subscribers";
import type { Order } from "../../src/store/orders";

const cfg = loadConfig();
const sub: Subscriber = {
  id: "s1", createdAt: 1, status: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", sizeId: "bouquet", cadenceId: "weekly",
  weekday: 2, fulfillment: "pickup", addressJson: null, deliveryAddOnCents: 0, anchorDate: "2026-09-15", pausedWeeks: [],
  customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: "518-555-0100", note: "no lilies",
};

describe("subscription messages", () => {
  it("confirmation carries the plan, first date, pickup text, price and portal link (copy approved 2026-09-10)", () => {
    const m = subscriptionConfirmedEmail(sub, cfg, "https://billing.example/cus_1");
    expect(m.to).toBe("pat@example.com");
    expect(m.subject).toBe("Your Bull and Bloom subscription starts Tue Sep 15");
    expect(m.text).toContain("Hi Pat,");
    expect(m.text).toContain("You're set for a Bouquet every week, on Tuesdays, for pickup.");
    expect(m.text).toContain("Your first one is Tuesday, September 15.");
    expect(m.text).toContain(`Pickup: ${cfg.studio.pickupInstructions}`);
    expect(m.text).toContain("Bouquet, every week: $290.00 a month");
    expect(m.text).toContain("Need to pause, cancel, or change your card? Manage it here:\nhttps://billing.example/cus_1");
    expect(m.text).not.toMatch(/skip a week/i);
  });
  it("cancellation says no more charges and this week's bouquet stays", () => {
    const m = subscriptionCancelledEmail(sub, cfg);
    expect(m.subject).toBe("Your Bull and Bloom subscription has ended");
    expect(m.text).toContain("Your Bouquet subscription is cancelled, and there won't be another charge.");
    expect(m.text).toContain("Any bouquet already on the calendar for this week is still yours.");
    expect(m.text.trim().endsWith("Anthony\nThe Bull and Bloom")).toBe(true);
  });
  it("owner copies name the plan and the person", () => {
    const s = ownerSubscriptionEmail(sub, cfg, "https://x.test", "started");
    expect(s.to).toBe(cfg.studio.ownerEmail);
    expect(s.subject).toBe("New subscription: Bouquet every week · Pat Smith · Tuesdays");
    expect(s.text).toContain("pat@example.com · 518-555-0100");
    expect(s.text).toContain("Note: no lilies");
    expect(s.text).toContain("First bouquet Tuesday, September 15.");
    const c = ownerSubscriptionEmail(sub, cfg, "https://x.test", "cancelled");
    expect(c.subject).toBe("Subscription cancelled: Bouquet every week · Pat Smith");
  });
  it("calendar events for subscription bouquets say so and hide the zero price", () => {
    const order = { id: "11111111-2222-4333-8444-555555555555", createdAt: 1, status: "paid", date: "2026-09-15", sizeId: "bouquet", fulfillment: "pickup",
      customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: null, addressJson: null, note: null, stripeSessionId: null,
      stripePaymentIntent: null, bouquetCents: 0, deliveryCents: 0, source: "subscription", holdExpiresAt: null, calendarEventId: null } as Order;
    const ev = orderEvent(order, cfg, "https://x.test");
    expect(ev.summary).toBe("Bouquet · Pat Smith · pickup (subscription)");
    expect(ev.description.split("\n")[0]).toBe("Bouquet · subscription · pickup");
    expect(ev.description).not.toContain("$0.00");
  });
});
