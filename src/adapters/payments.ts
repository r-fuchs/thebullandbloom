export interface CheckoutLineItem { name: string; amountCents: number; quantity: number }
export interface CheckoutInput {
  orderId: string; customerEmail: string; lineItems: CheckoutLineItem[];
  successUrl: string; cancelUrl: string; expiresAt: number; // unix seconds
}
export interface CheckoutSession { id: string; url: string }
export type WebhookEvent =
  | { type: "checkout.session.completed"; sessionId: string; paymentIntent: string }
  | { type: "checkout.session.expired"; sessionId: string }
  | { type: "other" };
export interface Payments {
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  parseWebhook(rawBody: string, signature: string): Promise<WebhookEvent>; // throws on bad signature
}
