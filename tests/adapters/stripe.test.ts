import { describe, it, expect } from "vitest";
import { checkoutParams, subscriptionParams, toWebhookEvent } from "../../src/adapters/stripe";

describe("toWebhookEvent", () => {
  it("maps completed sessions, with the tax Stripe collected", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_1", total_details: { amount_tax: 680 } } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_1", paymentIntent: "pi_1", taxCents: 680 });
  });
  it("maps expired sessions", () => {
    expect(toWebhookEvent({ type: "checkout.session.expired", data: { object: { id: "cs_2" } } }))
      .toEqual({ type: "checkout.session.expired", sessionId: "cs_2" });
  });
  it("maps everything else to other", () => {
    expect(toWebhookEvent({ type: "payment_intent.created", data: { object: {} } })).toEqual({ type: "other" });
  });
  it("tolerates an expanded payment_intent object and a session with no tax details", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_3", payment_intent: { id: "pi_3" } } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_3", paymentIntent: "pi_3", taxCents: 0 });
  });
});

describe("toWebhookEvent: subscriptions", () => {
  it("maps a subscription-mode checkout to subscription.started with ids and metadata", () => {
    const ev = toWebhookEvent({ type: "checkout.session.completed", data: { object: {
      id: "cs_s1", mode: "subscription", customer: "cus_9", subscription: { id: "sub_9" },
      customer_details: { email: "pat@example.com" }, metadata: { cell: "bouquet/weekly", weekday: "2", n: 5 },
    } } });
    expect(ev).toEqual({ type: "subscription.started", sessionId: "cs_s1", customerId: "cus_9", subscriptionId: "sub_9",
      customerEmail: "pat@example.com", metadata: { cell: "bouquet/weekly", weekday: "2" } });
  });
  it("maps subscription updates and deletions", () => {
    expect(toWebhookEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_9", status: "active", pause_collection: { behavior: "void" } } } }))
      .toEqual({ type: "subscription.updated", subscriptionId: "sub_9", status: "active", paused: true });
    expect(toWebhookEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_9", status: "past_due", pause_collection: null } } }))
      .toEqual({ type: "subscription.updated", subscriptionId: "sub_9", status: "past_due", paused: false });
    expect(toWebhookEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_9" } } }))
      .toEqual({ type: "subscription.deleted", subscriptionId: "sub_9" });
  });
});

describe("checkoutParams (Stripe Tax, D37; promotion codes, D40)", () => {
  const input = {
    orderId: "o1", customerEmail: "pat@example.com", customerName: "Pat Lee",
    taxAddress: { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" },
    lineItems: [
      { name: "Bouquet — delivery Wed Sep 23", amountCents: 8500, quantity: 1, taxCategory: "flowers" as const },
      { name: "Vase", amountCents: 2000, quantity: 1, taxCategory: "vase" as const },
      { name: "Delivery — Wed Sep 23", amountCents: 1200, quantity: 1, taxCategory: "delivery" as const },
    ],
    successUrl: "https://x/ok", cancelUrl: "https://x/no", expiresAt: 1_800_000_000,
  };
  it("turns on automatic tax, allows promotion codes, and prices every line tax-exclusive with a tax code", () => {
    const p = checkoutParams(input, "cus_1");
    expect(p.mode).toBe("payment");
    expect(p.customer).toBe("cus_1");
    expect(p.customer_email).toBeUndefined();
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.allow_promotion_codes).toBe(true);
    expect(p.customer_update).toEqual({ address: "auto" });
    expect(p.line_items!.map((li) => li.price_data!.tax_behavior)).toEqual(["exclusive", "exclusive", "exclusive"]);
    expect(p.line_items!.map((li) => li.price_data!.product_data!.tax_code)).toEqual(["txcd_99999999", "txcd_99999999", "txcd_92010001"]);
    expect(p.line_items![1].price_data!.unit_amount).toBe(2000);
    expect(p.metadata).toEqual({ order_id: "o1" });
    expect(p.expires_at).toBe(1_800_000_000);
  });
  it("subscription sessions get tax and promotion codes too", () => {
    const p = subscriptionParams({ customerEmail: "pat@example.com", productName: "Bouquet · every week", amountCents: 29000, metadata: { cell: "bouquet/weekly" }, successUrl: "https://x/ok", cancelUrl: "https://x/no" });
    expect(p.mode).toBe("subscription");
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.allow_promotion_codes).toBe(true);
    expect(p.line_items![0].price_data!.tax_behavior).toBe("exclusive");
    expect(p.line_items![0].price_data!.product_data!.tax_code).toBe("txcd_99999999");
  });
});
