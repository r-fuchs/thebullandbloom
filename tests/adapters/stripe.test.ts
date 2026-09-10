import { describe, it, expect } from "vitest";
import { toWebhookEvent } from "../../src/adapters/stripe";

describe("toWebhookEvent", () => {
  it("maps completed sessions", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_1" } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_1", paymentIntent: "pi_1" });
  });
  it("maps expired sessions", () => {
    expect(toWebhookEvent({ type: "checkout.session.expired", data: { object: { id: "cs_2" } } }))
      .toEqual({ type: "checkout.session.expired", sessionId: "cs_2" });
  });
  it("maps everything else to other", () => {
    expect(toWebhookEvent({ type: "payment_intent.created", data: { object: {} } })).toEqual({ type: "other" });
  });
  it("tolerates an expanded payment_intent object", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_3", payment_intent: { id: "pi_3" } } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_3", paymentIntent: "pi_3" });
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
