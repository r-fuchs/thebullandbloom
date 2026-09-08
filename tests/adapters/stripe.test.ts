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
