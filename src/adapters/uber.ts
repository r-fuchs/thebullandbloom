// Uber Direct behind one interface. Core, jobs and routes depend on this file only; the real
// implementation (uber-api.ts) and the test fake both satisfy it.
// Wire details verified from developer.uber.com on 2026-09-09; see the plan's Global Constraints.
import type { PostalAddress, StoreConfig } from "../config";

/**
 * The four timestamps Uber wants on a quote and a delivery. The API's own constraints
 * (verified 2026-09-09) are: pickupDeadline >= pickupReady + 10 min AND >= now + 20 min;
 * dropoffReady <= pickupDeadline; dropoffDeadline >= dropoffReady + 20 min AND >= pickupDeadline;
 * pickupReady < 30 days from now. `deliveryWindow()` in src/core/delivery.ts builds a
 * conforming set — never hand-assemble one.
 */
export interface DeliveryWindow {
  pickupReadyAt: Date; pickupDeadlineAt: Date; dropoffReadyAt: Date; dropoffDeadlineAt: Date;
}

/** One end of a delivery. `phone` is E.164; Uber rejects anything else. */
export interface Party {
  name: string;
  phone: string;
  address: PostalAddress;
  /** business name shown to the courier (studio side) */
  businessName?: string;
  /** free text for the courier, <= 280 chars (Uber's limit) */
  notes?: string;
}

export interface QuoteRequest { pickup: Party; dropoff: Party; window: DeliveryWindow; valueCents: number }

export interface UberQuote {
  id: string;
  feeCents: number;
  /** lowercase ISO currency, e.g. "usd" */
  currency: string;
  /** unix seconds; Uber's observed quote life is about 15 minutes */
  expiresAt: number;
  /** unix seconds, or null when Uber did not give one */
  dropoffEtaAt: number | null;
}

export interface DeliveryRequest {
  quoteId: string;
  pickup: Party;
  dropoff: Party;
  window: DeliveryWindow;
  valueCents: number;
  /** what is in the box, e.g. "Bouquet — hand-tied flowers" */
  itemName: string;
  /** shown to the courier as the order reference; we pass the short order id */
  reference: string;
  /** Uber de-duplicates on this for ~60 minutes; we pass the order id */
  idempotencyKey: string;
}

export interface UberDelivery {
  id: string;
  /** pending · pickup · pickup_complete · dropoff · delivered · canceled · returned */
  status: string;
  trackingUrl: string;
  feeCents: number;
}

/**
 * `unconfigured` — no Uber secrets on this deployment.
 * `undeliverable` — Uber will not serve this address (its 400 codes address_undeliverable,
 *   unknown_location, address_undeliverable_limited_couriers).
 * `unavailable`   — anything else: auth, timeout, 5xx, a malformed answer.
 * The first two mean "offer the fallback or hide delivery"; the third means "try again".
 */
export type UberFailureCode = "unconfigured" | "undeliverable" | "unavailable";

export class UberError extends Error {
  constructor(public readonly code: UberFailureCode, message: string) {
    super(message);
    this.name = "UberError";
  }
}

export interface Uber {
  /** true when UBER_CLIENT_ID, UBER_CLIENT_SECRET and UBER_CUSTOMER_ID are all set */
  configured(): boolean;
  quote(req: QuoteRequest): Promise<UberQuote>;
  createDelivery(req: DeliveryRequest): Promise<UberDelivery>;
}

/**
 * The adapter the app should use. With `delivery.mode: "flat"` in the config, Uber is switched off
 * at the wiring — quotes, the storefront's "offered" flag, admin status and Request courier all see
 * an unconfigured Uber and take the flat-fee path — without touching the secrets on the Worker.
 */
export function uberFor(cfg: StoreConfig, real: Uber): Uber {
  if (cfg.delivery.mode !== "flat") return real;
  const off = async () => { throw new UberError("unconfigured", "uber: switched off by delivery.mode flat"); };
  return { configured: () => false, quote: off, createDelivery: off };
}

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/**
 * Uber signs the raw webhook body with the dashboard's webhook signing key, HMAC-SHA256,
 * lowercase hex (verified 2026-09-09). The header is `x-uber-signature`; `x-postmates-signature`
 * is a legacy alias Uber still sends on delivery-status and courier-update events, so the route
 * accepts either. Compares digests of the two strings so the check is constant-time in length too.
 */
export async function verifyUberSignature(secret: string, rawBody: string, header: string | undefined): Promise<boolean> {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody))));
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(header.trim().toLowerCase())));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(expected)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
