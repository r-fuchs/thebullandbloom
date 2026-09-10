export interface CheckoutLineItem { name: string; amountCents: number; quantity: number }
export interface CheckoutInput {
  orderId: string; customerEmail: string; lineItems: CheckoutLineItem[];
  successUrl: string; cancelUrl: string; expiresAt: number; // unix seconds
}
export interface CheckoutSession { id: string; url: string }

/** A monthly subscription sold through Checkout with an ad-hoc recurring price (D27). */
export interface SubscriptionCheckoutInput {
  customerEmail: string;
  productName: string;      // e.g. "Bouquet · every week"
  amountCents: number;      // per month
  metadata: Record<string, string>; // copied onto the session and the subscription
  successUrl: string; cancelUrl: string;
}

export type WebhookEvent =
  | { type: "checkout.session.completed"; sessionId: string; paymentIntent: string }
  | { type: "checkout.session.expired"; sessionId: string }
  | { type: "subscription.started"; sessionId: string; customerId: string; subscriptionId: string; customerEmail: string; metadata: Record<string, string> }
  | { type: "subscription.updated"; subscriptionId: string; status: string; paused: boolean }
  | { type: "subscription.deleted"; subscriptionId: string }
  | { type: "other" };

export interface Payments {
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<CheckoutSession>;
  /** Stripe customer portal URL for pause, cancel, and card changes. */
  portalLink(customerId: string, returnUrl: string): Promise<string>;
  parseWebhook(rawBody: string, signature: string): Promise<WebhookEvent>; // throws on bad signature
}
