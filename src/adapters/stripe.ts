import Stripe from "stripe";
import type { CheckoutInput, CheckoutSession, Payments, WebhookEvent } from "./payments";

export function toWebhookEvent(e: { type: string; data: { object: any } }): WebhookEvent {
  const o = e.data.object;
  if (e.type === "checkout.session.completed") {
    const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id ?? "";
    return { type: "checkout.session.completed", sessionId: o.id, paymentIntent: pi };
  }
  if (e.type === "checkout.session.expired") return { type: "checkout.session.expired", sessionId: o.id };
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

  async parseWebhook(rawBody: string, signature: string): Promise<WebhookEvent> {
    const event = await this.stripe.webhooks.constructEventAsync(
      rawBody, signature, this.webhookSecret, undefined, Stripe.createSubtleCryptoProvider(),
    );
    return toWebhookEvent(event as any);
  }
}
