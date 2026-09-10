import Stripe from "stripe";
import type { CheckoutInput, CheckoutSession, Payments, SubscriptionCheckoutInput, WebhookEvent } from "./payments";

function stringMap(m: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (m && typeof m === "object") for (const [k, v] of Object.entries(m as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}
const idOf = (x: any): string => (typeof x === "string" ? x : x?.id ?? "");

export function toWebhookEvent(e: { type: string; data: { object: any } }): WebhookEvent {
  const o = e.data.object;
  if (e.type === "checkout.session.completed") {
    if (o.mode === "subscription") {
      return {
        type: "subscription.started", sessionId: o.id, customerId: idOf(o.customer), subscriptionId: idOf(o.subscription),
        customerEmail: o.customer_details?.email ?? o.customer_email ?? "", metadata: stringMap(o.metadata),
      };
    }
    return { type: "checkout.session.completed", sessionId: o.id, paymentIntent: idOf(o.payment_intent) };
  }
  if (e.type === "checkout.session.expired") return { type: "checkout.session.expired", sessionId: o.id };
  if (e.type === "customer.subscription.updated") {
    return { type: "subscription.updated", subscriptionId: o.id, status: String(o.status ?? ""), paused: Boolean(o.pause_collection) };
  }
  if (e.type === "customer.subscription.deleted") return { type: "subscription.deleted", subscriptionId: o.id };
  return { type: "other" };
}

export class StripePayments implements Payments {
  private stripe: Stripe;
  constructor(secretKey: string, private webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: input.customerEmail,
      client_reference_id: input.orderId,
      metadata: { order_id: input.orderId },
      line_items: input.lineItems.map((li) => ({
        quantity: li.quantity,
        price_data: { currency: "usd", unit_amount: li.amountCents, product_data: { name: li.name } },
      })),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: input.expiresAt,
    });
    if (!session.url) throw new Error("stripe: session has no url");
    return { id: session.id, url: session.url };
  }

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: input.customerEmail,
      metadata: input.metadata,
      subscription_data: { metadata: input.metadata },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd", unit_amount: input.amountCents, recurring: { interval: "month" },
          product_data: { name: input.productName },
        },
      }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("stripe: session has no url");
    return { id: session.id, url: session.url };
  }

  async portalLink(customerId: string, returnUrl: string): Promise<string> {
    const s = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return s.url;
  }

  async parseWebhook(rawBody: string, signature: string): Promise<WebhookEvent> {
    const event = await this.stripe.webhooks.constructEventAsync(
      rawBody, signature, this.webhookSecret, undefined, Stripe.createSubtleCryptoProvider(),
    );
    return toWebhookEvent(event as any);
  }
}
