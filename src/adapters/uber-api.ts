import {
  UberError, type DeliveryRequest, type Party, type QuoteRequest, type Uber, type UberDelivery, type UberQuote,
} from "./uber";
import type { PostalAddress } from "../config";
import type { TokenCache } from "../store/uber";

const AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const API = "https://api.uber.com/v1";
const SCOPE = "eats.deliveries";
/** Refresh this far before the token's stated expiry so a call never races the boundary. */
const TOKEN_SKEW_SECONDS = 3600;
/** Neither Uber endpoint below is expected to take anywhere near this; a stuck request should fail, not hang the request. */
const UBER_TIMEOUT_MS = 15_000;

/**
 * Runs `fn` and guarantees only a `UberError` escapes: a rejected `fetch` (DNS/connection
 * failure, our own `AbortSignal.timeout`), a rejected `res.text()`, or a rejected D1 cache call
 * all surface as raw, unwrapped errors otherwise. The plan's Global Constraints call for exactly
 * the three `UberFailureCode`s out of `quote`/`createDelivery`, so anything else collapses to
 * "unavailable" (try again) rather than propagating.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UberError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new UberError("unavailable", `uber: ${msg}`.slice(0, 300));
  }
}

/** Uber's 400 codes that mean "we do not serve this address", as opposed to "try again". */
const UNDELIVERABLE = new Set(["address_undeliverable", "unknown_location", "address_undeliverable_limited_couriers"]);

/**
 * Uber takes each address as a JSON-encoded STRING (not a nested object), with `street_address`
 * as an array of lines. Verified from the Create Quote schema on 2026-09-09.
 */
export function encodeAddress(a: PostalAddress): string {
  const lines = a.unit && a.unit.trim() !== "" ? [a.street, a.unit] : [a.street];
  return JSON.stringify({ street_address: lines, city: a.city, state: a.state, zip_code: a.zip, country: "US" });
}

function secondsFrom(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

interface TokenResponse { access_token: string; expires_in: number }
interface QuoteResponse { id?: string; fee?: number; currency?: string; expires?: string; dropoff_eta?: string }
interface DeliveryResponse { id?: string; status?: string; tracking_url?: string; fee?: number }

export class UberApi implements Uber {
  constructor(
    private clientId: string | undefined,
    private clientSecret: string | undefined,
    private customerId: string | undefined,
    private cache: TokenCache,
    /** true on the sandbox deployment: Create Delivery carries Uber's Robocourier block */
    private robocourier = false,
    private fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  configured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.customerId);
  }

  async quote(req: QuoteRequest): Promise<UberQuote> {
    return guard(async () => {
      const body = {
        pickup_address: encodeAddress(req.pickup.address),
        pickup_phone_number: req.pickup.phone,
        dropoff_address: encodeAddress(req.dropoff.address),
        dropoff_phone_number: req.dropoff.phone,
        ...windowFields(req.window),
        manifest_total_value: req.valueCents,
      };
      const r = await this.api<QuoteResponse>(`/customers/${this.customerId}/delivery_quotes`, body);
      const expiresAt = secondsFrom(r.expires);
      if (typeof r.id !== "string" || typeof r.fee !== "number" || expiresAt === null) {
        throw new UberError("unavailable", `uber: quote response missing id, fee or expires: ${JSON.stringify(r).slice(0, 200)}`);
      }
      return {
        id: r.id, feeCents: r.fee, currency: typeof r.currency === "string" ? r.currency : "usd",
        expiresAt, dropoffEtaAt: secondsFrom(r.dropoff_eta),
      };
    });
  }

  async createDelivery(req: DeliveryRequest): Promise<UberDelivery> {
    return guard(async () => {
      const body: Record<string, unknown> = {
        quote_id: req.quoteId,
        ...partyFields("pickup", req.pickup),
        ...partyFields("dropoff", req.dropoff),
        ...windowFields(req.window),
        // `size: "small"` is the value from Uber's own manifest example; a bouquet is a one-hand
        // parcel. The full size enum is not documented on the pages we could read (see Global
        // Constraints, unverified item 3).
        manifest_items: [{ name: req.itemName, quantity: 1, size: "small", price: req.valueCents }],
        manifest_reference: req.reference,
        manifest_total_value: req.valueCents,
        // Leave the bouquet at the door (Ryan for Anthony, 2026-09-14); nobody needs to be home.
        deliverable_action: "deliverable_action_leave_at_door",
        undeliverable_action: "leave_at_door",
        idempotency_key: req.idempotencyKey,
        external_id: req.reference,
      };
      if (this.robocourier) body.test_specifications = { robo_courier_specification: { mode: "auto" } };

      const r = await this.api<DeliveryResponse>(`/customers/${this.customerId}/deliveries`, body);
      if (typeof r.id !== "string" || typeof r.status !== "string" || typeof r.tracking_url !== "string" || typeof r.fee !== "number") {
        throw new UberError("unavailable", `uber: delivery response missing id, status, tracking_url or fee: ${JSON.stringify(r).slice(0, 200)}`);
      }
      return { id: r.id, status: r.status, trackingUrl: r.tracking_url, feeCents: r.fee };
    });
  }

  /** Client-credentials token, cached in D1 across isolates (D30). Uber allows 100 of these an hour. */
  private async accessToken(force = false): Promise<string> {
    if (!this.configured()) throw new UberError("unconfigured", "uber: not configured");
    const nowSec = Math.floor(Date.now() / 1000);
    if (!force) {
      const hit = await this.cache.load();
      // D38: a token minted by another app (the sandbox keys before cutover) is never reused.
      if (hit && hit.clientId === this.clientId && hit.expiresAt - TOKEN_SKEW_SECONDS > nowSec) return hit.token;
    }
    const form = new URLSearchParams({
      client_id: this.clientId!, client_secret: this.clientSecret!,
      grant_type: "client_credentials", scope: SCOPE,
    });
    const res = await this.fetchFn(AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(UBER_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new UberError("unavailable", `uber token ${res.status}: ${text.slice(0, 300)}`);
    let t: TokenResponse;
    try { t = JSON.parse(text) as TokenResponse; }
    catch { throw new UberError("unavailable", `uber token: response was not JSON: ${text.slice(0, 200)}`); }
    if (typeof t.access_token !== "string") throw new UberError("unavailable", "uber token: no access_token in response");
    // Uber's documented lifetime is 2592000s (30 days); trust whatever it actually says.
    const lifetime = Number.isFinite(t.expires_in) ? t.expires_in : 2592000;
    await this.cache.save({ token: t.access_token, expiresAt: nowSec + lifetime, clientId: this.clientId! });
    return t.access_token;
  }

  /** Authenticated JSON POST. Retries once after a 401 with a freshly minted token. */
  private async api<T>(path: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await this.fetchFn(`${API}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UBER_TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) { await this.cache.clear(); continue; }
      const text = await res.text();
      if (res.ok) {
        try { return JSON.parse(text) as T; }
        catch { throw new UberError("unavailable", `uber ${path}: response was not JSON: ${text.slice(0, 200)}`); }
      }
      let code = "";
      try { code = String((JSON.parse(text) as { code?: string }).code ?? ""); } catch { /* body was not JSON */ }
      const kind = UNDELIVERABLE.has(code) ? "undeliverable" : "unavailable";
      throw new UberError(kind, `uber ${path} ${res.status}${code ? ` ${code}` : ""}: ${text.slice(0, 300)}`);
    }
  }
}

function partyFields(side: "pickup" | "dropoff", p: Party): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [`${side}_name`]: p.name,
    [`${side}_address`]: encodeAddress(p.address),
    [`${side}_phone_number`]: p.phone,
  };
  if (p.businessName) out[`${side}_business_name`] = p.businessName;
  if (p.notes) out[`${side}_notes`] = p.notes.slice(0, 280); // Uber's documented limit
  return out;
}

function windowFields(w: { pickupReadyAt: Date; pickupDeadlineAt: Date; dropoffReadyAt: Date; dropoffDeadlineAt: Date }) {
  return {
    pickup_ready_dt: w.pickupReadyAt.toISOString(),
    pickup_deadline_dt: w.pickupDeadlineAt.toISOString(),
    dropoff_ready_dt: w.dropoffReadyAt.toISOString(),
    dropoff_deadline_dt: w.dropoffDeadlineAt.toISOString(),
  };
}
