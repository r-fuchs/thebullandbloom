import type { PostalAddress } from "../config";

/** Which Stripe tax code a line carries (spec Plan 5 D37). */
export type TaxCategory = "flowers" | "vase" | "delivery";
export interface CheckoutLineItem { name: string; amountCents: number; quantity: number; taxCategory: TaxCategory }
export interface CheckoutInput {
  orderId: string; customerEmail: string; customerName: string;
  /** where the flowers go: the delivery address, or the studio for pickup. Stripe Tax's location. */
  taxAddress: PostalAddress;
  lineItems: CheckoutLineItem[];
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
  | { type: "checkout.session.completed"; sessionId: string; paymentIntent: string; taxCents: number; discountCents: number }
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
