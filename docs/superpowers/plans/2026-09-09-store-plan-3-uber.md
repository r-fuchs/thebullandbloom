# Store Plan 3: Uber Direct delivery (quote at checkout, courier on the day) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can have a bouquet delivered — priced from their own address at checkout — and Anthony sends a courier for it with one tap when the bouquet is made, while the customer gets a tracking link and the order closes itself on delivery.

**Architecture:** An `Uber` adapter interface with a fake for tests and a real `fetch`-based implementation over Uber Direct (no SDK), behind the same shape Plan 2 used for Google. `POST /api/quote` prices the address for the order date and returns the fee inside an HMAC-signed token, so `POST /api/checkout` can lock that exact fee on the order without trusting the browser or re-pricing. On the day, `POST /admin/api/orders/:id/dispatch` takes a fresh quote, creates the delivery, writes a `deliveries` row and queues the customer's tracking email through Plan 2's outbox in the same D1 batch. `POST /webhooks/uber` moves that row's status and turns `delivered` into a `done` order. When Uber is absent or will not serve an address, a flat fee for a configured ZIP list keeps delivery on sale with Anthony driving.

**Tech Stack:** Cloudflare Workers, D1, Hono, TypeScript, Uber Direct API v1 over `fetch`, Web Crypto (HMAC-SHA256), Vitest with `@cloudflare/vitest-pool-workers`, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-07-store-design.md`. This plan implements §2 item 6 (Delivery), the delivery half of item 8 (admin "request courier" and the delivery fee variance total), and item 10's courier tracking email; §4.2's delivery config; §4.3's `deliveries` table and `orders.uber_quote_id` / `address_json`; §4.4's "Quote", the delivery parts of "Checkout", and the whole "Courier request" flow; §4.5's two Uber rows; §5's `adapters/uber` and the `uber` half of `routes/webhooks`; §6's delivery morning; §7 item 1. Decisions D8 (fee locked at order time, variance on Anthony) and D24 (the calendar event, whose description now carries the address) are the spec decisions this plan is built on. **Nothing from subscriptions is in this plan** — D7's per-signup delivery add-on, D14, and spec §2 item 5 are Plan 4. Neither is Instagram (§2 item 7) or the DNS cutover.

**Delegation (MeOS convention):** Tasks 1–11 are exact-spec builds with a verifiable finish line: dispatch each with `model: "sonnet"`. Task 12 is a credentialed account setup and an acceptance walk-through against a real Uber sandbox, and stays in the main session with Ryan. Every Agent call passes `model` explicitly; a missing override is a bug.

## Global Constraints

- Timezone for all date math: `America/New_York` (spec §4.2). Dates are `YYYY-MM-DD` strings everywhere; never a JS `Date` for a calendar day. A studio-local wall time becomes an instant only through `instantAt(tz, ymd, hm)` (Task 2).
- Money is integer cents everywhere. Never floats. Display through `dollars(cents)` in `src/core/messages.ts`.
- **The customer pays the fee they were quoted (spec D8).** Nothing in this plan may re-charge a customer, add a surcharge, or change `orders.delivery_cents` after checkout. Day-of variance lands on Anthony's margin and is shown as a running total in admin.
- **A courier is never dispatched by a timer (spec D9).** The only thing that creates a delivery is Anthony pressing a button. No cron, no webhook, and no checkout may call `createDelivery`.
- Delivery degrades, never breaks the store (spec §4.5): Uber unreachable, unconfigured, or refusing an address must leave pickup working and the page usable. `UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`, `UBER_CUSTOMER_ID` and `UBER_WEBHOOK_SECRET` are OPTIONAL Wrangler bindings, exactly as Plan 2 made the Google pair.
- A failed dispatch leaves the order `paid` (spec §4.5). No failure path may cancel, refund, or "done" an order.
- Secrets never in the repo (spec §4.7). The Uber values come from Wrangler secrets; `.dev.vars` is gitignored.
- Core modules (`src/core/*`) import nothing from `src/adapters`, `src/store`, `src/jobs`, or Hono. Type-only imports from `src/adapters/uber.ts` and `src/store/orders.ts`, and value imports from `src/config.ts`, are the same allowances Plans 1 and 2 already use.
- Order truth stays in D1 (spec D4). Uber is told about an order; it is never asked what an order is.
- Uber API calls use `fetch` directly. No Uber SDK (there is no Workers-compatible one, and the surface used here is three endpoints).
- Every task ends with `npm test` and `npm run typecheck` green and a commit on branch `feat/store`.
- Storefront and admin page stay plain HTML/CSS/JS, ES5 style as in Plans 1 and 2, no build step.
- Email is plain text only (`text/plain; charset=utf-8`), sent through Plan 2's outbox and Gmail adapter. No new mail transport.

### Uber Direct API facts this plan depends on

**Verified from developer.uber.com on 2026-09-09** (`/docs/deliveries/get-started`, `/docs/deliveries/guides/authentication`, `/docs/deliveries/api-reference/daas`, `/docs/deliveries/guides/robocourier`, `/docs/deliveries/guides/webhooks`, `/docs/deliveries/daas/references/api/webhooks/delivery-status-webhook`):

1. Token: `POST https://auth.uber.com/oauth/v2/token`, `application/x-www-form-urlencoded`, `client_id` + `client_secret` + `grant_type=client_credentials` + `scope=eats.deliveries`. Response `{ access_token, expires_in, token_type, scope }`, with `expires_in` of `2592000` (30 days). Token requests are limited to 100/hour and the docs say to cache and reuse.
2. Create Quote: `POST https://api.uber.com/v1/customers/{customer_id}/delivery_quotes`.
3. Create Delivery: `POST https://api.uber.com/v1/customers/{customer_id}/deliveries`. Get Delivery: `GET https://api.uber.com/v1/customers/{customer_id}/deliveries/{delivery_id}`.
4. `pickup_address` and `dropoff_address` are **JSON-encoded strings**, not nested objects, with keys `street_address` (an array of lines), `city`, `state`, `zip_code`, `country`.
5. The four scheduling fields are RFC 3339 strings (`"2024-12-12T14:00:00.000Z"`), and the documented constraints are, verbatim: `pickup_ready_dt` "Must be less than 30 days in the future"; `pickup_deadline_dt` "Must be at least 10 mins later than pickup_ready_dt and at least 20 minutes in the future from now"; `dropoff_ready_dt` "Must be less than or equal to pickup_deadline_dt"; `dropoff_deadline_dt` "Must be at least 20 mins later than dropoff_ready_dt and must be greater than or equal to pickup_deadline_dt". `deliveryWindow()` in Task 5 is the single place these are satisfied.
6. Quote response: `id`, `created`, `expires`, `fee` (cents), `currency`, `currency_type`, `dropoff_eta`, `duration`, `pickup_duration`, `dropoff_deadline`.
7. Delivery request fields used here: `quote_id`, `pickup_name`, `pickup_address`, `pickup_phone_number`, `pickup_business_name`, `pickup_notes` (≤280 chars), the four `dropoff_*` equivalents, `manifest_items`, `manifest_reference`, `manifest_total_value` (cents), `deliverable_action`, `undeliverable_action`, `idempotency_key` (de-duplicates for ~60 minutes), `external_id`, `test_specifications`. `deliverable_action` ∈ {`deliverable_action_meet_at_door` (default), `deliverable_action_leave_at_door`}; `undeliverable_action` ∈ {`leave_at_door`, `return` (default), `discard`}. Phone fields match `^\+[0-9]+$`.
8. Delivery response fields used here: `id`, `status`, `tracking_url`, `fee` (cents), `currency`, `undeliverable_reason`.
9. Robocourier: `"test_specifications": { "robo_courier_specification": { "mode": "auto" } }`, with `mode` ∈ {`auto`, `custom`}. Sandbox is **not a separate host** — the same `api.uber.com` with test-mode credentials issued in the dashboard.
10. Webhook payload: top-level `kind`, with `"event.delivery_status"` the one this plan handles; the delivery id at top-level `delivery_id`; the status at top-level `status` and again at `data.status`. Other kinds are `event.courier_update`, `event.refund_request`, `event.shopping_progress`.
11. Statuses: `pending`, `pickup`, `pickup_complete`, `dropoff`, `delivered`, `canceled` (one L), `returned`.
12. Webhook signature: header **`x-uber-signature`**, HMAC-SHA256 of the raw request body keyed by the dashboard's Webhook Signing Key, lowercase hex. `x-postmates-signature` is a legacy alias Uber still accepts for delivery-status and courier-update events. The docs' own worked example (key `c5c26d5a-70d6-46c7-a652-d7c09825ad29`, that payload, digest `cdff8133…cedd65`) is used verbatim as a test fixture in Task 4.
13. Webhook retries: on 5xx, timeout, or network error, first retry at 10 s then 30/60/120 s, three attempts total. Hence the handler answers 200 to anything it cannot act on.
14. Errors: `400` with a `{ code, message, kind: "error" }` body — `address_undeliverable`, `unknown_location`, `address_undeliverable_limited_couriers`, `invalid_params`, `pickup_window_too_small`, `pickup_ready_too_late`, and others; `401 unauthorized`; `402 customer_suspended`; `403 customer_blocked`; `404 customer_not_found`; `408 request_timeout`; `409 duplicate_delivery`; `429 customer_limited`; `500 internal_server_error`.

**Unverified, assumed** — each is either not load-bearing or has a named fallback:

- **Quote lifetime of ~15 minutes.** Only inferable from one example's `created`→`expires` pair; no prose states it as policy. Nothing depends on it: the adapter reads `expires` off the response, and the signed token takes `min(that, now + 15 min)`.
- **An "expired quote" error code.** No such literal code appears in the documented list. Nothing depends on it: dispatch always mints a fresh quote seconds before creating the delivery.
- **`manifest_items[].size`.** The enum is not documented on the pages that render; `"small"` is copied verbatim from Uber's own example item. If Uber 400s on it during Task 12 Step 4, drop the field and re-run — nothing else reads it.
- **`data.undeliverable_reason` on a delivery-status webhook.** The delivery object documents the field and the webhook's `data` is that object, but its presence on `canceled`/`returned` events is not stated. Task 9 treats it as optional and stores `null` when absent; the status itself is what admin keys off.
- **The Uber Direct dashboard's navigation** — "Developer → Credentials", "Developer → Webhooks", "Webhook Signing Key" (Task 12 Step 2). Taken from docs prose; the dashboard is behind a login. If the labels differ, follow the equivalent screens.
- **Whether the dashboard accepts two webhook URLs** (preview and production at once). Task 12 registers the preview and adds production if allowed, else it becomes a one-line cutover step.
- Also worth recording, so nobody re-hunts them: `developer.uber.com/docs/deliveries/introduction`, `.../create-quote`, `.../create-delivery`, `.../get-delivery` and `.../sandbox` do not exist. The reference is the single Redoc page at `/docs/deliveries/api-reference/daas`.

## Decisions made while planning (engineering internals; Ryan can veto any)

| # | Decision | Alternatives | Why |
|---|---|---|---|
| D26 | `store.config.json` gains `studio.readyTime` (HH:MM), `studio.phone` (E.164), a structured `studio.address` (street/unit/city/state/zip), and `delivery: { fallbackFeeCents, fallbackZips[] }`. The existing free-text `studio.pickupAddress` stays as the customer-facing display string. | Parse the free-text pickup address; put the courier address in admin settings | Uber wants a structured address and a dialable phone; a display string that reads "SAMPLE — studio address, Upstate NY" cannot become either. Keeping both means the confirmation email's wording is still Anthony's, while the courier gets machine-readable fields. All four are §7 blanks Anthony fills before cutover. |
| D27 | The `deliveries` column is `fee_cents`, not the spec's `actual_cents`, and the variance total is `SUM(fee_cents − orders.delivery_cents)` over non-terminal deliveries. | Keep `actual_cents`; compare against `deliveries.quoted_cents` | `fee_cents` is the name Uber uses for the same number, so the mapping is obvious at a glance. And the variance Anthony cares about is against what the *customer paid* (`orders.delivery_cents`), not against the day-of quote — the day-of quote and the day-of fee are the same number in every non-pathological case. `quoted_cents` is still stored, for diagnosing a case where they differ. |
| D28 | Migration 0003 rebuilds the `outbox` table to admit the `courier_email` kind, copying every row across. | A second table for courier mail; drop the CHECK constraint entirely | SQLite cannot alter a CHECK constraint, and the constraint is worth keeping — it is what stops a typo'd kind from sitting undeliverable forever. The copy preserves in-flight Plan 2 messages with their attempt counts. |
| D29 | The courier email is queued by an UPSERT that revives a completed row, and it rides in the same `db.batch` as the `deliveries` insert. | A plain `INSERT OR IGNORE` like the paid-order kinds | `UNIQUE(order_id, kind)` means a second courier for the same order (after a cancellation) would otherwise find its row already done and send nothing — the customer would get a tracking link for a courier that no longer exists and none for the one that does. Batching with the insert gives the same guarantee D20 gives the paid-order kinds: a courier that exists always has its email queued. |
| D30 | The Uber access token is cached in D1 `settings` under `uber.token`, in plaintext. | In-isolate memory only; AES-GCM like the Google token (D18) | Workers isolates are short-lived, and Uber allows only 100 token requests an hour, so the cache has to outlive the isolate. Plaintext, unlike D18, because this is a machine credential for the store's own Uber organisation and is worthless to anyone who does not also have `UBER_CLIENT_SECRET` — encrypting it would add a failure mode (a rotated `ADMIN_SECRET` silently breaking couriers) and buy nothing. Any 401 clears and re-mints it. |
| D31 | The delivery fee travels from `/api/quote` to `/api/checkout` inside an HMAC-signed token (payload: fee, quote id, kind, date, address fingerprint, expiry), not as a number in the request body. | Trust the posted fee; re-quote inside checkout; a `quotes` table | A posted fee is a price the browser sets. Re-quoting means the customer can be charged a different number from the one they just agreed to, seconds later, with no way to notice — which is exactly what D8 exists to prevent. A table would work but adds schema and a sweep for something that is naturally stateless. The signature key is `ADMIN_SECRET`, already required. |
| D32 | The checkout-time quote is scheduled for the studio's ready time on the order date. Beyond Uber's 30-day scheduling limit it degrades to an ASAP quote, marked as an estimate. | Always quote ASAP; refuse delivery beyond 30 days | Uber prices by distance and by *when*; an ASAP quote taken at 11 pm for a Saturday morning delivery can be wrong in either direction. The storefront only offers 28 days, so the degraded branch is a safety net for `/api/checkout`'s wider 62-day horizon, not a normal path. |
| D33 | A failed dispatch is reported in the HTTP response and rendered next to the button; it is not written to the database. | A `deliveries` row with a null delivery id; a `dispatch_errors` table | Anthony is standing in front of the screen when he presses the button — the error has an audience of one, right now, and his next move is to press it again or pick up his keys. A persisted failure would need its own lifecycle (when is it cleared?) for no reader. `deliveries.last_error` still records problems reported *after* a courier exists, which do have to survive a page reload. |

## Decisions Ryan made (pending)

Answered before execution starts (Task 12 Step 1 turns each into a config edit or one adapter line). Framed as what Anthony would notice:

1. **Where the courier picks up and whom they call.** The studio's real street address and a phone a courier can ring from the curb. Both are SAMPLE today; a sandbox courier can run on samples, a real one cannot.
2. **What time bouquets are ready each morning.** That is the hour the customer's delivery price is quoted for at checkout, and the earliest a courier would be scheduled.
3. **Where Anthony drives himself when Uber will not go.** A list of ZIPs and one flat fee, or "none, pickup only there". Without a list, an address Uber refuses simply shows "outside our delivery area".
4. **Hand it over or leave it at the door.** And if nobody answers: bring it back to the studio, or leave it. (Default in the plan: hand over; bring it back.)
5. **Whose Uber account.** Ryan opens a sandbox organisation now so the build is not waiting on Uber; Anthony's production organisation, with his billing, is applied for in parallel and can take weeks. Confirm Anthony is ready to give Uber his business details.

## File structure

```
migrations/0003_delivery.sql      orders.uber_quote_id · deliveries · outbox gains courier_email (D27, D28)
store.config.json                 + studio.readyTime/phone/address, delivery.fallback* (D26)
src/
  env.ts                          + UBER_CLIENT_ID? UBER_CLIENT_SECRET? UBER_CUSTOMER_ID? UBER_WEBHOOK_SECRET? UBER_ROBOCOURIER?
  config.ts                       + PostalAddress, studio.readyTime/phone/address, delivery, and their validation
  app.ts                          Services += uber
  index.ts                        servicesFor builds UberApi over the D1 token cache
  adapters/uber.ts                Uber interface + types + UberError + verifyUberSignature
  adapters/uber-api.ts            UberApi (real): token, delivery_quotes, deliveries over fetch
  store/uber.ts                   uber.token cache in settings (D30)
  store/deliveries.ts             insert · active · by date · applyStatus · varianceTotal
  store/orders.ts                 + uberQuoteId, addressJson on insert, markDoneIfPaid
  store/outbox.ts                 + courier_email kind, enqueueCourierEmailStatement (D29)
  core/time.ts                    + instantAt (studio wall clock → instant)
  core/delivery.ts                deliveryWindow · pickupReadyFor · parseAddress · addressKey · fallbackFeeFor · normalizePhone
  core/quote-token.ts             signQuote / verifyQuote (D31)
  core/messages.ts                + deliveryAddressOf, formatAddress, courierEmail; delivery wording in the rest
  jobs/outbox.ts                  + courier_email delivery case
  routes/public.ts                + POST /api/quote; checkout accepts delivery
  routes/webhooks.ts              + POST /webhooks/uber
  routes/admin.ts                 orders endpoint returns deliveries; mounts registerDeliveryAdmin
  routes/admin-delivery.ts        GET /admin/api/delivery/status · POST /admin/api/orders/:id/dispatch
site/index.html                   pickup/delivery choice, address fields, total line
site/store.js                     reveal, debounced quote, signed-token checkout
site/admin/index.html             address on each order, Request courier, tracking line, Delivery panel
scripts/uber-setup.sh             four secrets, remote migration, preview redeploy with Robocourier
tests/
  fakes/uber.ts                   FakeUber
  helpers.ts                      testApp/testServices return uber
  adapters/uber-api.test.ts  core/delivery.test.ts  core/quote-token.test.ts  core/time.test.ts (+)
  store/uber.test.ts  store/deliveries.test.ts  store/orders.test.ts (+)  store/outbox.test.ts (+)
  core/messages.test.ts (+)  jobs/outbox.test.ts (+)
  routes/public.test.ts (+)  routes/webhooks.test.ts (+)  routes/admin.test.ts (~)  routes/admin-delivery.test.ts
  config.test.ts (+)  smoke.test.ts (+)
```

---
### Task 1: Uber adapter interface, fake, optional bindings, and service wiring

**Files:**
- Create: `src/adapters/uber.ts`, `tests/fakes/uber.ts`
- Modify: `src/env.ts`, `src/app.ts`, `src/index.ts`, `tests/helpers.ts`, `tests/setup.ts`, `vitest.config.ts`, `wrangler.toml`
- Test: `tests/smoke.test.ts`, `tests/index.test.ts`, `tests/scheduled.test.ts` (existing; must still pass)

**Interfaces:**
- Consumes: `PostalAddress` from `src/config.ts` (Task 2). Task 2 has no dependency on this task, so an executor may do them in either order; if this task runs first, add the `PostalAddress` interface to `src/config.ts` here exactly as Task 2 Step 4 spells it and leave Task 2's other edits alone.
- Produces (all `src/adapters/uber.ts`): `DeliveryWindow`, `Party`, `QuoteRequest`, `UberQuote`, `DeliveryRequest`, `UberDelivery`, `UberFailureCode`, `UberError`, `Uber`, `verifyUberSignature`. Plus `Services.uber: Uber` (`src/app.ts`), `FakeUber` (`tests/fakes/uber.ts`), and `testApp()` / `testServices()` now returning `uber` alongside `payments` and `google`.
- Note: `src/adapters/uber-api.ts` (the real adapter) is Task 4. Until then `servicesFor` uses the unconfigured stub in Step 5, so the Worker builds and every route behaves as "Uber not set up".

- [ ] **Step 1: Write the interface**

`src/adapters/uber.ts`:

```ts
// Uber Direct behind one interface. Core, jobs and routes depend on this file only; the real
// implementation (uber-api.ts) and the test fake both satisfy it.
// Wire details verified from developer.uber.com on 2026-09-09; see the plan's Global Constraints.
import type { PostalAddress } from "../config";

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
```

- [ ] **Step 2: Write the fake**

`tests/fakes/uber.ts`:

```ts
import type {
  DeliveryRequest, QuoteRequest, Uber, UberDelivery, UberFailureCode, UberQuote,
} from "../../src/adapters/uber";
import { UberError } from "../../src/adapters/uber";

export class FakeUber implements Uber {
  isConfigured = true;
  /** every quote request seen, newest last */
  quoted: QuoteRequest[] = [];
  /** every delivery request seen, newest last */
  created: DeliveryRequest[] = [];
  /** what the next quote() returns; the id gains a counter suffix so ids stay unique */
  quoteFee = 1200;
  quoteExpiresAt = 2_000_000_000;
  /** when set, the next call throws this once */
  failNext: { code: UberFailureCode; message: string } | null = null;
  private n = 0;

  configured() { return this.isConfigured; }

  async quote(req: QuoteRequest): Promise<UberQuote> {
    this.maybeFail();
    this.quoted.push(req);
    this.n += 1;
    return {
      id: `dqt_fake_${this.n}`, feeCents: this.quoteFee, currency: "usd",
      expiresAt: this.quoteExpiresAt, dropoffEtaAt: this.quoteExpiresAt + 1800,
    };
  }

  async createDelivery(req: DeliveryRequest): Promise<UberDelivery> {
    this.maybeFail();
    this.created.push(req);
    this.n += 1;
    return {
      id: `del_fake_${this.n}`, status: "pending",
      trackingUrl: `https://track.uber.test/del_fake_${this.n}`, feeCents: this.quoteFee,
    };
  }

  /** convenience for tests that want the failure path */
  failWith(code: UberFailureCode, message = code) { this.failNext = { code, message }; }

  private maybeFail() {
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      throw new UberError(f.code, f.message);
    }
  }
}
```

- [ ] **Step 3: Add the optional bindings**

`src/env.ts` becomes:

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SITE_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_PASSCODE: string;
  ADMIN_SECRET: string;
  GOOGLE_CLIENT_ID?: string;     // optional: admin reports "not configured" when absent
  GOOGLE_CLIENT_SECRET?: string;
  UBER_CLIENT_ID?: string;       // optional: without these, delivery falls back or hides (spec §4.5)
  UBER_CLIENT_SECRET?: string;
  UBER_CUSTOMER_ID?: string;
  UBER_WEBHOOK_SECRET?: string;
  /** "1" on the sandbox deployment: Create Delivery then carries Uber's Robocourier test block */
  UBER_ROBOCOURIER?: string;
}
```

`src/index.ts`'s `REQUIRED_SECRETS` list is unchanged: none of the Uber values is required, exactly as the Google pair is not.

Add the same names to `tests/setup.ts`'s ambient `Cloudflare.Env`:

```ts
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      UBER_CLIENT_ID?: string;
      UBER_CLIENT_SECRET?: string;
      UBER_CUSTOMER_ID?: string;
      UBER_WEBHOOK_SECRET?: string;
      UBER_ROBOCOURIER?: string;
      TEST_MIGRATIONS: D1Migration[];
```

and to `vitest.config.ts`'s `miniflare.bindings`, after the Google pair:

```ts
            UBER_CLIENT_ID: "test-uber-client",
            UBER_CLIENT_SECRET: "test-uber-secret",
            UBER_CUSTOMER_ID: "cus_test",
            UBER_WEBHOOK_SECRET: "test-webhook-secret",
```

`UBER_ROBOCOURIER` is deliberately NOT bound in tests: the fake never reads it, and leaving it unset keeps the "production shape" as the default the suite exercises.

- [ ] **Step 4: Widen `Services`**

`src/app.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "./env";
import type { Payments } from "./adapters/payments";
import type { Google } from "./adapters/google";
import type { Uber } from "./adapters/uber";
import type { StoreConfig } from "./config";
import { publicRoutes } from "./routes/public";
import { webhookRoutes } from "./routes/webhooks";
import { adminRoutes } from "./routes/admin";

export interface Services { payments: Payments; google: Google; uber: Uber; clock: () => Date; config: StoreConfig }
export type App = Hono<{ Bindings: Env; Variables: { services: Services } }>;
```

The rest of `buildApp` is unchanged.

- [ ] **Step 5: Wire a stub in `servicesFor` (replaced in Task 4)**

In `src/index.ts`, inside `servicesFor`, add the stub and pass it through:

```ts
    const uber: Uber = {
      configured: () => false,
      async quote() { throw new UberError("unconfigured", "uber: adapter not built yet (Plan 3 Task 4)"); },
      async createDelivery() { throw new UberError("unconfigured", "uber: adapter not built yet (Plan 3 Task 4)"); },
    };
    services = { payments, google, uber, clock: () => new Date(), config: loadConfig() };
```

with `import { UberError, type Uber } from "./adapters/uber";` added to the imports. Task 4 deletes this stub and constructs `UberApi` in its place.

- [ ] **Step 6: Update the test helpers**

In `tests/helpers.ts`, import the fake and hand it to both builders:

```ts
import { FakeUber } from "./fakes/uber";
```

```ts
export function testApp(now = new Date("2026-09-08T14:00:00Z")) {
  const payments = new RecordingPayments();
  const google = new FakeGoogle();
  const uber = new FakeUber();
  const app = buildApp({ payments, google, uber, clock: () => now, config: loadConfig() });
  const fetch = (path: string, init?: RequestInit) =>
    app.request(new Request(`https://example.com${path}`, init), undefined, env);
  return { app, payments, google, uber, fetch };
}

/** Services object for jobs and runScheduled tests, sharing testApp's fakes. */
export function testServices(now = new Date("2026-09-08T14:00:00Z")) {
  const payments = new RecordingPayments();
  const google = new FakeGoogle();
  const uber = new FakeUber();
  return { services: { payments, google, uber, clock: () => now, config: loadConfig() }, payments, google, uber };
}
```

- [ ] **Step 7: Declare the secrets in wrangler.toml's comments**

Wrangler secrets are not declared in `wrangler.toml`, but the file is where the next person looks. Add above `[vars]`:

```toml
# Secrets (wrangler secret put): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_PASSCODE, ADMIN_SECRET,
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, UBER_CLIENT_ID, UBER_CLIENT_SECRET, UBER_CUSTOMER_ID,
# UBER_WEBHOOK_SECRET. The Google and Uber sets are optional; without them those features report
# "not set up" and delivery falls back to the flat-fee zip list (spec §4.5).
```

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: every Plan 1 and Plan 2 test still green. Nothing calls `uber` yet, so behaviour is unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/uber.ts tests/fakes/uber.ts src/env.ts src/app.ts src/index.ts tests/helpers.ts tests/setup.ts vitest.config.ts wrangler.toml
git commit -m "feat(uber): adapter interface, signature verifier, test fake, and service wiring"
```

---
### Task 2: Config — studio ready time, structured studio address, delivery fallback

**Files:**
- Modify: `store.config.json`, `src/config.ts`, `tests/config.test.ts`, `src/core/time.ts`, `tests/core/time.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `StoreConfig.studio.readyTime: string` (HH:MM), `StoreConfig.studio.phone: string` (E.164), `StoreConfig.studio.address: PostalAddress`, `StoreConfig.delivery: { fallbackFeeCents: number; fallbackZips: string[] }`, and the exported `PostalAddress` interface (`src/config.ts`). Also `instantAt(tz, ymd, hm): Date` in `src/core/time.ts`.
- Note: `PostalAddress` is defined here and re-used by Task 1's adapter types and Task 5's core. Defining it in `config.ts` (not `adapters/uber.ts`) keeps `src/core/*` free of adapter imports.

- [ ] **Step 1: Write the failing config tests**

Append to `tests/config.test.ts`:

```ts
  it("loads the studio ready time, phone, structured address, and delivery fallback", () => {
    const cfg = loadConfig();
    expect(cfg.studio.readyTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(cfg.studio.phone).toMatch(/^\+1\d{10}$/);
    expect(cfg.studio.address.state).toHaveLength(2);
    expect(cfg.studio.address.zip).toMatch(/^\d{5}$/);
    expect(Number.isInteger(cfg.delivery.fallbackFeeCents)).toBe(true);
    expect(Array.isArray(cfg.delivery.fallbackZips)).toBe(true);
  });
  it("rejects a bad ready time", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, readyTime: "9am" } })).toThrow(/readyTime/);
  });
  it("rejects a studio phone that is not E.164", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, phone: "(518) 334-0517" } })).toThrow(/studio.phone/);
  });
  it("rejects an incomplete studio address", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, address: { ...base.studio.address, zip: "1253" } } })).toThrow(/studio.address.zip/);
    expect(() => validateConfig({ ...base, studio: { ...base.studio, address: { ...base.studio.address, state: "New York" } } })).toThrow(/studio.address.state/);
    expect(() => validateConfig({ ...base, studio: { ...base.studio, address: { ...base.studio.address, city: "" } } })).toThrow(/studio.address.city/);
  });
  it("rejects a bad delivery fallback", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, delivery: { fallbackFeeCents: -1, fallbackZips: [] } })).toThrow(/fallbackFeeCents/);
    expect(() => validateConfig({ ...base, delivery: { fallbackFeeCents: 1500, fallbackZips: ["1253"] } })).toThrow(/fallbackZips/);
  });
  it("accepts an empty fallback zip list (no fallback offered)", () => {
    const base = loadConfig();
    expect(validateConfig({ ...base, delivery: { fallbackFeeCents: 1500, fallbackZips: [] } }).delivery.fallbackZips).toEqual([]);
  });
```

Append to `tests/core/time.test.ts`:

```ts
import { instantAt } from "../../src/core/time";

describe("instantAt", () => {
  it("resolves a studio-local wall time to the right UTC instant in EDT", () => {
    expect(instantAt("America/New_York", "2026-09-15", "09:00").toISOString()).toBe("2026-09-15T13:00:00.000Z");
  });
  it("resolves the same wall time to a different instant in EST", () => {
    expect(instantAt("America/New_York", "2026-12-15", "09:00").toISOString()).toBe("2026-12-15T14:00:00.000Z");
  });
  it("handles the spring-forward day (2 am does not exist; 3 am local is returned)", () => {
    // 2027-03-14 is the US spring-forward date. 02:30 local does not exist; the
    // two-pass fixpoint lands on the instant Intl reports as 03:30 EDT.
    const d = instantAt("America/New_York", "2027-03-14", "02:30");
    expect(hmIn("America/New_York", d)).toBe("03:30");
  });
  it("round-trips any ordinary time through ymdIn/hmIn", () => {
    const d = instantAt("America/New_York", "2026-11-20", "16:45");
    expect(ymdIn("America/New_York", d)).toBe("2026-11-20");
    expect(hmIn("America/New_York", d)).toBe("16:45");
  });
});
```

(`hmIn` and `ymdIn` are already imported at the top of `tests/core/time.test.ts`; add `instantAt` to that same import rather than a second import line if the file already imports from `../../src/core/time`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts tests/core/time.test.ts`
Expected: FAIL — `instantAt` is not exported, and `cfg.studio.readyTime` is undefined.

- [ ] **Step 3: Extend the repo config**

`store.config.json` becomes (D26; SAMPLE values until Anthony supplies his, exactly as Plan 1 did for prices and pickup text — spec §7):

```json
{
  "timezone": "America/New_York",
  "studio": {
    "pickupAddress": "SAMPLE — studio address, Upstate NY",
    "pickupInstructions": "SAMPLE — text Anthony at (518) 334-0517 when you arrive.",
    "ownerEmail": "thebullandbloom@gmail.com",
    "readyTime": "09:00",
    "phone": "+15183340517",
    "address": {
      "street": "SAMPLE — 1 Warren Street",
      "unit": "",
      "city": "Hudson",
      "state": "NY",
      "zip": "12534"
    }
  },
  "calendars": { "closed": "Bull and Bloom: Closed", "orders": "Bull and Bloom: Orders" },
  "sizes": [
    { "id": "posy", "name": "Posy", "description": "A small hand-tied bunch. SAMPLE.", "priceCents": 5500 },
    { "id": "bouquet", "name": "Bouquet", "description": "The classic 10–12 stem bouquet. SAMPLE.", "priceCents": 8500 },
    { "id": "statement", "name": "Statement", "description": "A generous, showpiece bouquet. SAMPLE.", "priceCents": 13500 }
  ],
  "defaults": { "cap": 4, "cutoff": "11:00", "openWeekdays": [2, 3, 4, 5, 6] },
  "delivery": { "fallbackFeeCents": 1500, "fallbackZips": ["12534", "12106", "12075"] },
  "holdMinutes": 30
}
```

- [ ] **Step 4: Extend the config types and validation**

`src/config.ts` — replace the `StoreConfig` interface and add the new checks inside `validateConfig`:

```ts
import raw from "../store.config.json";

export interface Size { id: string; name: string; description: string; priceCents: number }
/** Structured address, the shape the Uber adapter and the storefront both use. */
export interface PostalAddress { street: string; unit: string; city: string; state: string; zip: string }
export interface StoreConfig {
  timezone: string;
  studio: {
    pickupAddress: string; pickupInstructions: string; ownerEmail: string;
    /** studio-local HH:MM the bouquets are ready for a courier (spec §7) */
    readyTime: string;
    /** E.164; Uber requires a callable pickup number */
    phone: string;
    address: PostalAddress;
  };
  calendars: { closed: string; orders: string };
  sizes: Size[];
  defaults: { cap: number; cutoff: string; openWeekdays: number[] };
  /** Used only when Uber is unavailable for the address (spec §4.2, §4.5). Empty zip list = no fallback. */
  delivery: { fallbackFeeCents: number; fallbackZips: string[] };
  holdMinutes: number;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZIP = /^\d{5}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

export function validateConfig(cfg: StoreConfig): StoreConfig {
  if (!cfg.timezone) throw new Error("config: timezone required");
  if (!HM.test(cfg.defaults.cutoff)) throw new Error("config: defaults.cutoff must be HH:MM");
  if (!Number.isInteger(cfg.defaults.cap) || cfg.defaults.cap < 0) throw new Error("config: defaults.cap must be a non-negative integer");
  if (!cfg.defaults.openWeekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error("config: openWeekdays must be 0..6");
  if (!Number.isInteger(cfg.holdMinutes) || cfg.holdMinutes < 30) throw new Error("config: holdMinutes must be an integer >= 30 (Stripe minimum)");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.studio?.ownerEmail ?? "")) throw new Error("config: studio.ownerEmail must be an email address");
  if (!HM.test(cfg.studio?.readyTime ?? "")) throw new Error("config: studio.readyTime must be HH:MM");
  if (!E164.test(cfg.studio?.phone ?? "")) throw new Error("config: studio.phone must be E.164, e.g. +15183340517");
  const a = cfg.studio?.address;
  if (!a || typeof a.street !== "string" || a.street.trim() === "") throw new Error("config: studio.address.street required");
  if (typeof a.unit !== "string") throw new Error("config: studio.address.unit must be a string (empty when there is none)");
  if (typeof a.city !== "string" || a.city.trim() === "") throw new Error("config: studio.address.city required");
  if (!/^[A-Z]{2}$/.test(a.state ?? "")) throw new Error("config: studio.address.state must be a two-letter code");
  if (!ZIP.test(a.zip ?? "")) throw new Error("config: studio.address.zip must be five digits");
  const d = cfg.delivery;
  if (!d || !Number.isInteger(d.fallbackFeeCents) || d.fallbackFeeCents < 0) throw new Error("config: delivery.fallbackFeeCents must be a non-negative integer");
  if (!Array.isArray(d.fallbackZips) || !d.fallbackZips.every((z) => ZIP.test(z))) throw new Error("config: delivery.fallbackZips must be five-digit zips");
  if (!cfg.calendars?.closed || !cfg.calendars?.orders || cfg.calendars.closed === cfg.calendars.orders)
    throw new Error("config: calendars.closed and calendars.orders must be two distinct names");
  const ids = new Set<string>();
  for (const s of cfg.sizes) {
    if (ids.has(s.id)) throw new Error(`config: duplicate size id ${s.id}`);
    ids.add(s.id);
    if (!Number.isInteger(s.priceCents) || s.priceCents <= 0) throw new Error(`config: size ${s.id} priceCents must be a positive integer`);
  }
  return cfg;
}

export function loadConfig(): StoreConfig {
  return validateConfig(raw as StoreConfig);
}

export function sizeById(cfg: StoreConfig, id: string): Size | undefined {
  return cfg.sizes.find((s) => s.id === id);
}
```

- [ ] **Step 5: Add `instantAt` to core/time**

Append to `src/core/time.ts` (after `hmIn`, which it uses):

```ts
/**
 * The UTC instant at which the clock in `tz` reads `hm` on `ymd`.
 * Two passes: the first correction uses the offset at the naive instant, which can be the wrong
 * side of a DST change; re-measuring at the corrected instant settles it. On a spring-forward
 * gap (a wall time that does not exist) this returns the instant one hour later, which is what a
 * courier pickup at "2:30 am on the day the clocks jump" should mean anyway.
 */
export function instantAt(tz: string, ymd: string, hm: string): Date {
  const naive = Date.parse(`${ymd}T${hm}:00Z`);
  let t = naive;
  for (let i = 0; i < 2; i++) {
    const at = new Date(t);
    const shown = Date.parse(`${ymdIn(tz, at)}T${hmIn(tz, at)}:00Z`);
    t += naive - shown;
  }
  return new Date(t);
}
```

- [ ] **Step 6: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/config.test.ts tests/core/time.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green. Plan 1 and 2 tests are untouched by this task.

- [ ] **Step 7: Commit**

```bash
git add store.config.json src/config.ts src/core/time.ts tests/config.test.ts tests/core/time.test.ts
git commit -m "feat(config): studio ready time, structured address and phone, delivery fallback; instantAt"
```

---
### Task 3: Migration 0003 — `orders.uber_quote_id`, the `deliveries` table, and the `courier_email` outbox kind

**Files:**
- Create: `migrations/0003_delivery.sql`, `src/store/deliveries.ts`, `tests/store/deliveries.test.ts`
- Modify: `src/store/orders.ts`, `src/store/outbox.ts`, `tests/store/orders.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces (all `src/store/deliveries.ts`): `DeliveryStatus`, `TERMINAL_STATUSES`, `Delivery`, `NewDelivery`, `insertDeliveryStatement(db, d)`, `insertDelivery(db, d)`, `activeDeliveryFor(db, orderId)`, `latestDeliveryFor(db, orderId)`, `deliveriesForDate(db, date)`, `applyStatus(db, uberDeliveryId, status, reason, now)`, `varianceTotal(db)`.
- Produces (`src/store/orders.ts`): `Order.uberQuoteId: string | null`, and `NewOrder.addressJson: string | null` + `NewOrder.uberQuoteId: string | null` accepted by `tryInsertHeldOrder`.
- Produces (`src/store/outbox.ts`): `OutboxKind` now includes `"courier_email"`; new `enqueueCourierEmailStatement(db, orderId, now)`.

- [ ] **Step 1: Write the migration**

`migrations/0003_delivery.sql`:

```sql
-- Plan 3 (Uber Direct delivery). Three changes:
--  1. orders.uber_quote_id — the checkout-time quote id, informational only (D8: the FEE is
--     what is locked, in delivery_cents; the quote itself expires in minutes).
--  2. deliveries — one row per courier job Anthony requests (spec §4.3).
--  3. outbox gains the 'courier_email' kind. SQLite cannot alter a CHECK constraint, so the
--     table is rebuilt and its rows copied (D28).

ALTER TABLE orders ADD COLUMN uber_quote_id TEXT;

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  uber_delivery_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  quoted_cents INTEGER NOT NULL,   -- the day-of quote this delivery was created from
  fee_cents INTEGER NOT NULL,      -- what Uber says the job costs (spec §4.3 called this actual_cents; D27)
  tracking_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX deliveries_order ON deliveries (order_id);

CREATE TABLE outbox_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_event','email_customer','email_owner','courier_email')),
  order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  done_at INTEGER,
  UNIQUE (order_id, kind)
);
INSERT INTO outbox_new (id, kind, order_id, created_at, attempts, next_attempt_at, last_error, done_at)
  SELECT id, kind, order_id, created_at, attempts, next_attempt_at, last_error, done_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX outbox_due ON outbox (done_at, next_attempt_at);
```

The rebuild copies every column by name, so a queued-but-undelivered message survives the migration with its attempt count and backoff intact. `DROP TABLE outbox` also drops `outbox_due`, which is why the index is recreated at the end.

- [ ] **Step 2: Write the failing store tests**

`tests/store/deliveries.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyStatus, activeDeliveryFor, deliveriesForDate, insertDelivery, latestDeliveryFor, varianceTotal,
} from "../../src/store/deliveries";

async function order(id: string, date: string, deliveryCents: number, status = "paid") {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       bouquet_cents, delivery_cents)
     VALUES (?, 1, ?, ?, 'bouquet', 'delivery', 'Pat Smith', 'pat@example.com', 8500, ?)`,
  ).bind(id, status, date, deliveryCents).run();
}

const row = (orderId: string, uberId: string, quoted: number, fee: number) => ({
  id: `del_${uberId}`, orderId, uberDeliveryId: uberId, status: "pending" as const,
  quotedCents: quoted, feeCents: fee, trackingUrl: `https://track.uber.test/${uberId}`, at: 1000,
});

describe("store/deliveries", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
  });

  it("inserts a delivery and finds it as the active one for its order", async () => {
    await order("o1", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o1", "u1", 1300, 1300));
    const d = await activeDeliveryFor(env.DB, "o1");
    expect(d).toMatchObject({
      orderId: "o1", uberDeliveryId: "u1", status: "pending",
      quotedCents: 1300, feeCents: 1300, trackingUrl: "https://track.uber.test/u1",
      createdAt: 1000, updatedAt: 1000, lastError: null,
    });
    expect(await activeDeliveryFor(env.DB, "nope")).toBeNull();
  });

  it("refuses a second row for the same uber delivery id", async () => {
    await order("o2", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o2", "u2", 1300, 1300));
    await expect(insertDelivery(env.DB, row("o2", "u2", 1300, 1300))).rejects.toThrow();
  });

  it("stops counting a canceled or returned delivery as active, so a re-dispatch is allowed", async () => {
    await order("o3", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o3", "u3", 1300, 1300));
    await applyStatus(env.DB, "u3", "canceled", "courier could not reach the door", 2000);
    expect(await activeDeliveryFor(env.DB, "o3")).toBeNull();
    await insertDelivery(env.DB, row("o3", "u3b", 1400, 1400));
    expect((await activeDeliveryFor(env.DB, "o3"))!.uberDeliveryId).toBe("u3b");
  });

  it("applies a status update by uber delivery id and returns the row; unknown ids return null", async () => {
    await order("o4", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o4", "u4", 1300, 1300));
    const d = await applyStatus(env.DB, "u4", "pickup_complete", null, 2500);
    expect(d).toMatchObject({ orderId: "o4", status: "pickup_complete", updatedAt: 2500, lastError: null });
    expect(await applyStatus(env.DB, "unknown", "delivered", null, 2600)).toBeNull();
  });

  it("records a reason on a failure status and clears it on a later good one", async () => {
    await order("o5", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o5", "u5", 1300, 1300));
    await applyStatus(env.DB, "u5", "returned", "nobody home", 2000);
    expect((await env.DB.prepare("SELECT last_error FROM deliveries WHERE uber_delivery_id = 'u5'").first<any>()).last_error)
      .toBe("nobody home");
    await applyStatus(env.DB, "u5", "dropoff", null, 2100);
    expect((await env.DB.prepare("SELECT last_error FROM deliveries WHERE uber_delivery_id = 'u5'").first<any>()).last_error)
      .toBeNull();
  });

  it("is idempotent: replaying the same status leaves one row and the same values", async () => {
    await order("o6", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o6", "u6", 1300, 1300));
    await applyStatus(env.DB, "u6", "delivered", null, 3000);
    await applyStatus(env.DB, "u6", "delivered", null, 3000);
    const rows = await env.DB.prepare("SELECT status, updated_at FROM deliveries WHERE uber_delivery_id = 'u6'").all<any>();
    expect(rows.results).toEqual([{ status: "delivered", updated_at: 3000 }]);
  });

  it("finds the latest delivery for an order whatever its status, and none for a stranger", async () => {
    await order("o5", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o5", "u5a", 1300, 1300));
    await applyStatus(env.DB, "u5a", "canceled", "studio cancelled", 2000);
    expect((await latestDeliveryFor(env.DB, "o5"))!.uberDeliveryId).toBe("u5a");
    await insertDelivery(env.DB, { ...row("o5", "u5b", 1300, 1300), at: 3000 });
    expect((await latestDeliveryFor(env.DB, "o5"))!.uberDeliveryId).toBe("u5b");
    expect(await latestDeliveryFor(env.DB, "nope")).toBeNull();
  });

  it("ignores a second insert of the same Uber delivery id (Uber de-duplicated a double dispatch)", async () => {
    await order("o10", "2026-09-16", 1200);
    await insertDelivery(env.DB, row("o10", "u10", 1300, 1300));
    await insertDelivery(env.DB, { ...row("o10", "u10", 1300, 1300), id: "del_u10_again" });
    const rows = await env.DB.prepare("SELECT id FROM deliveries WHERE uber_delivery_id = 'u10'").all<any>();
    expect(rows.results).toEqual([{ id: "del_u10" }]);
  });

  it("lists the deliveries for a date keyed by order id", async () => {
    await order("o7", "2026-09-17", 1200);
    await order("o8", "2026-09-17", 1200);
    await order("o9", "2026-09-18", 1200);
    await insertDelivery(env.DB, row("o7", "u7", 1300, 1300));
    await insertDelivery(env.DB, row("o9", "u9", 1300, 1300));
    const m = await deliveriesForDate(env.DB, "2026-09-17");
    expect([...m.keys()]).toEqual(["o7"]);
    expect(m.get("o7")!.uberDeliveryId).toBe("u7");
  });

  it("totals the variance Anthony absorbed, ignoring canceled jobs", async () => {
    await order("v1", "2026-09-16", 1200);
    await order("v2", "2026-09-16", 1500);
    await order("v3", "2026-09-16", 1000);
    await insertDelivery(env.DB, row("v1", "uv1", 1400, 1400));  // +200 over what the customer paid
    await insertDelivery(env.DB, row("v2", "uv2", 1300, 1300));  // -200 under
    await insertDelivery(env.DB, row("v3", "uv3", 9900, 9900));  // canceled, must not count
    await applyStatus(env.DB, "uv3", "canceled", "studio cancelled", 2000);
    expect(await varianceTotal(env.DB)).toEqual({ deliveries: 2, varianceCents: 0 });
    await insertDelivery(env.DB, row("v1", "uv1b", 1700, 1700));
    expect(await varianceTotal(env.DB)).toEqual({ deliveries: 3, varianceCents: 500 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/store/deliveries.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/deliveries'`.

- [ ] **Step 4: Implement the deliveries store**

`src/store/deliveries.ts`:

```ts
/** The Uber delivery lifecycle (spec §4.4). Terminal failures free the order for another attempt. */
export type DeliveryStatus =
  | "pending" | "pickup" | "pickup_complete" | "dropoff" | "delivered" | "canceled" | "returned";

/** A delivery in one of these is over; Anthony may request a new courier for the order. */
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = ["canceled", "returned"];

export interface Delivery {
  id: string; orderId: string; uberDeliveryId: string; status: DeliveryStatus;
  quotedCents: number; feeCents: number; trackingUrl: string;
  createdAt: number; updatedAt: number; lastError: string | null;
}
export interface NewDelivery {
  id: string; orderId: string; uberDeliveryId: string; status: DeliveryStatus;
  quotedCents: number; feeCents: number; trackingUrl: string; at: number;
}

interface Row {
  id: string; order_id: string; uber_delivery_id: string; status: DeliveryStatus;
  quoted_cents: number; fee_cents: number; tracking_url: string;
  created_at: number; updated_at: number; last_error: string | null;
}
const COLS = `id, order_id, uber_delivery_id, status, quoted_cents, fee_cents, tracking_url,
  created_at, updated_at, last_error`;

function fromRow(r: Row): Delivery {
  return {
    id: r.id, orderId: r.order_id, uberDeliveryId: r.uber_delivery_id, status: r.status,
    quotedCents: r.quoted_cents, feeCents: r.fee_cents, trackingUrl: r.tracking_url,
    createdAt: r.created_at, updatedAt: r.updated_at, lastError: r.last_error,
  };
}

const NOT_TERMINAL = `status NOT IN ('canceled','returned')`;

/**
 * The INSERT as a statement, so dispatch can batch it with the courier-email enqueue (D29).
 * OR IGNORE: when Uber de-duplicates a double dispatch (same idempotency key) it hands back the
 * delivery we already stored, and the second insert must be a no-op rather than a UNIQUE failure.
 */
export function insertDeliveryStatement(db: D1Database, d: NewDelivery): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO deliveries (id, order_id, uber_delivery_id, status, quoted_cents, fee_cents, tracking_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(d.id, d.orderId, d.uberDeliveryId, d.status, d.quotedCents, d.feeCents, d.trackingUrl, d.at, d.at);
}

export async function insertDelivery(db: D1Database, d: NewDelivery): Promise<void> {
  await insertDeliveryStatement(db, d).run();
}

/** The live courier job for an order, if any. Canceled and returned jobs do not block a retry. */
export async function activeDeliveryFor(db: D1Database, orderId: string): Promise<Delivery | null> {
  const r = await db.prepare(
    `SELECT ${COLS} FROM deliveries WHERE order_id = ? AND ${NOT_TERMINAL} ORDER BY created_at DESC LIMIT 1`,
  ).bind(orderId).first<Row>();
  return r ? fromRow(r) : null;
}

/** The newest delivery for an order in any status; dispatch keys its idempotency on it. */
export async function latestDeliveryFor(db: D1Database, orderId: string): Promise<Delivery | null> {
  const r = await db.prepare(
    `SELECT ${COLS} FROM deliveries WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(orderId).first<Row>();
  return r ? fromRow(r) : null;
}

/** The most recent delivery per order for one order date, for the admin day panel. */
export async function deliveriesForDate(db: D1Database, date: string): Promise<Map<string, Delivery>> {
  const rows = await db.prepare(
    `SELECT ${COLS.split(",").map((c) => `d.${c.trim()}`).join(", ")}
     FROM deliveries d JOIN orders o ON o.id = d.order_id
     WHERE o.date = ? ORDER BY d.created_at`,
  ).bind(date).all<Row>();
  const out = new Map<string, Delivery>();
  for (const r of rows.results) out.set(r.order_id, fromRow(r)); // later rows win: the newest attempt
  return out;
}

/**
 * Move a delivery to `status`. Idempotent: replaying the same event rewrites the same values.
 * `reason` is stored on a failure status and cleared on any other, so admin shows only a live problem.
 * Returns the updated row, or null when we have never heard of this delivery.
 */
export async function applyStatus(
  db: D1Database, uberDeliveryId: string, status: DeliveryStatus, reason: string | null, now: number,
): Promise<Delivery | null> {
  const keepReason = (TERMINAL_STATUSES as readonly string[]).includes(status);
  await db.prepare("UPDATE deliveries SET status = ?, updated_at = ?, last_error = ? WHERE uber_delivery_id = ?")
    .bind(status, now, keepReason ? reason?.slice(0, 500) ?? null : null, uberDeliveryId).run();
  const r = await db.prepare(`SELECT ${COLS} FROM deliveries WHERE uber_delivery_id = ?`).bind(uberDeliveryId).first<Row>();
  return r ? fromRow(r) : null;
}

/**
 * What Anthony's margin absorbed (D8): Uber's fee minus what the customer was charged, over every
 * delivery that actually ran. A positive number means he paid the difference.
 */
export async function varianceTotal(db: D1Database): Promise<{ deliveries: number; varianceCents: number }> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(d.fee_cents - o.delivery_cents), 0) AS v
     FROM deliveries d JOIN orders o ON o.id = d.order_id
     WHERE d.${NOT_TERMINAL}`,
  ).first<{ n: number; v: number }>();
  return { deliveries: r?.n ?? 0, varianceCents: r?.v ?? 0 };
}
```

- [ ] **Step 5: Widen `Order` and `NewOrder`**

In `src/store/orders.ts`, add `uber_quote_id` to the row type, the column list, the mapper, and the insert. Replace the top of the file down to `tryInsertHeldOrder` with:

```ts
export type OrderStatus = "held" | "paid" | "done" | "cancelled" | "refunded";
export type Fulfillment = "pickup" | "delivery";

export interface Order {
  id: string; createdAt: number; status: OrderStatus; date: string; sizeId: string; fulfillment: Fulfillment;
  customerName: string; customerEmail: string; customerPhone: string | null; addressJson: string | null; note: string | null;
  stripeSessionId: string | null; stripePaymentIntent: string | null; bouquetCents: number; deliveryCents: number;
  uberQuoteId: string | null;
  source: "one_time" | "subscription"; holdExpiresAt: number | null; calendarEventId: string | null;
}
export interface NewOrder {
  id: string; date: string; sizeId: string; fulfillment: Fulfillment; customerName: string; customerEmail: string;
  customerPhone: string | null; addressJson: string | null; note: string | null;
  bouquetCents: number; deliveryCents: number; uberQuoteId: string | null;
}

interface Row {
  id: string; created_at: number; status: OrderStatus; date: string; size_id: string; fulfillment: Fulfillment;
  customer_name: string; customer_email: string; customer_phone: string | null; address_json: string | null; note: string | null;
  stripe_session_id: string | null; stripe_payment_intent: string | null; bouquet_cents: number; delivery_cents: number;
  uber_quote_id: string | null;
  source: "one_time" | "subscription"; hold_expires_at: number | null; calendar_event_id: string | null;
}
const COLS = `id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, customer_phone,
  address_json, note, stripe_session_id, stripe_payment_intent, bouquet_cents, delivery_cents, uber_quote_id,
  source, hold_expires_at, calendar_event_id`;

function fromRow(r: Row): Order {
  return {
    id: r.id, createdAt: r.created_at, status: r.status, date: r.date, sizeId: r.size_id, fulfillment: r.fulfillment,
    customerName: r.customer_name, customerEmail: r.customer_email, customerPhone: r.customer_phone,
    addressJson: r.address_json, note: r.note, stripeSessionId: r.stripe_session_id,
    stripePaymentIntent: r.stripe_payment_intent, bouquetCents: r.bouquet_cents, deliveryCents: r.delivery_cents,
    uberQuoteId: r.uber_quote_id,
    source: r.source, holdExpiresAt: r.hold_expires_at, calendarEventId: r.calendar_event_id,
  };
}

const USED = `SELECT COUNT(*) FROM orders WHERE date = ?1 AND source = 'one_time' AND status IN ('held','paid','done')`;

export async function countUsed(db: D1Database, from: string, to: string): Promise<Map<string, number>> {
  const rows = await db.prepare(
    `SELECT date, COUNT(*) AS n FROM orders WHERE date BETWEEN ? AND ? AND source = 'one_time' AND status IN ('held','paid','done') GROUP BY date`,
  ).bind(from, to).all<{ date: string; n: number }>();
  return new Map(rows.results.map((r) => [r.date, r.n]));
}

export async function tryInsertHeldOrder(
  db: D1Database, o: NewOrder, cap: number, now: number, holdExpiresAt: number,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, note, bouquet_cents, delivery_cents, uber_quote_id, source, hold_expires_at)
     SELECT ?2, ?3, 'held', ?1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'one_time', ?14
     WHERE (${USED}) < ?15`,
  ).bind(o.date, o.id, now, o.sizeId, o.fulfillment, o.customerName, o.customerEmail, o.customerPhone,
    o.addressJson, o.note, o.bouquetCents, o.deliveryCents, o.uberQuoteId, holdExpiresAt, cap).run();
  return res.meta.changes === 1;
}
```

Everything below `tryInsertHeldOrder` in that file is unchanged.

The existing `tests/store/orders.test.ts` builds `NewOrder` literals; add `addressJson: null, uberQuoteId: null` to each so it typechecks. Add one new case there:

```ts
  it("stores an address and quote id on a delivery order", async () => {
    const ok = await tryInsertHeldOrder(env.DB, {
      id: "ord-delivery", date: "2026-10-06", sizeId: "bouquet", fulfillment: "delivery",
      customerName: "Pat", customerEmail: "pat@example.com", customerPhone: "+15185550100",
      addressJson: JSON.stringify({ street: "5 Elm St", unit: "", city: "Hudson", state: "NY", zip: "12534", notes: "porch" }),
      note: null, bouquetCents: 8500, deliveryCents: 1200, uberQuoteId: "dqt_abc",
    }, 4, 1000, 2000);
    expect(ok).toBe(true);
    const o = (await getOrder(env.DB, "ord-delivery"))!;
    expect(o.fulfillment).toBe("delivery");
    expect(o.deliveryCents).toBe(1200);
    expect(o.uberQuoteId).toBe("dqt_abc");
    expect(JSON.parse(o.addressJson!).zip).toBe("12534");
  });
```

- [ ] **Step 6: Add the courier outbox kind**

In `src/store/outbox.ts`, widen the kind union and add the enqueue used by dispatch (Task 8):

```ts
export type OutboxKind = "calendar_event" | "email_customer" | "email_owner" | "courier_email";
export const ORDER_PAID_KINDS: readonly OutboxKind[] = ["calendar_event", "email_customer", "email_owner"];
```

and, after `enqueueForSessionStatements`, add:

```ts
/**
 * Queue the courier tracking email for an order. Unlike the paid-order kinds this is an UPSERT that
 * revives the row: a re-dispatch after a canceled courier must send a fresh tracking link, and
 * UNIQUE(order_id, kind) means the same row is reused (D29).
 */
export function enqueueCourierEmailStatement(db: D1Database, orderId: string, now: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at)
     VALUES (?1, 'courier_email', ?2, ?3, 0, ?3)
     ON CONFLICT(order_id, kind) DO UPDATE SET attempts = 0, next_attempt_at = ?3, last_error = NULL, done_at = NULL`,
  ).bind(crypto.randomUUID(), orderId, now);
}
```

Add to `tests/store/outbox.test.ts`, and add `enqueueCourierEmailStatement` to that file's import from `../../src/store/outbox`:

```ts
  it("queues a courier email and revives the row on a re-dispatch", async () => {
    await order("c1", "cs_c1", "paid");
    await env.DB.batch([enqueueCourierEmailStatement(env.DB, "c1", 1000)]);
    const id = (await env.DB.prepare("SELECT id FROM outbox WHERE order_id = 'c1'").first<any>()).id;
    await markDone(env.DB, id, 1100);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    await env.DB.batch([enqueueCourierEmailStatement(env.DB, "c1", 2000)]);
    const rows = await env.DB.prepare("SELECT kind, attempts, next_attempt_at, done_at FROM outbox WHERE order_id = 'c1'").all<any>();
    expect(rows.results).toEqual([{ kind: "courier_email", attempts: 0, next_attempt_at: 2000, done_at: null }]);
  });
```

`src/jobs/outbox.ts`'s `deliver` switch now has a missing case for `"courier_email"`, which TypeScript reports because the function's return type is `Promise<boolean>` and the switch is exhaustive. Task 7 adds the real case; until then add, as the last case in the switch:

```ts
    case "courier_email": throw new Error("outbox: courier_email is implemented in Task 7");
```

- [ ] **Step 7: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/store/deliveries.test.ts tests/store/orders.test.ts tests/store/outbox.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green. The migration is applied automatically to the test D1 by `readD1Migrations` in `vitest.config.ts`; nothing there changes.

- [ ] **Step 8: Commit**

```bash
git add migrations/0003_delivery.sql src/store/deliveries.ts src/store/orders.ts src/store/outbox.ts tests/store
git commit -m "feat(db): deliveries table, orders.uber_quote_id, courier_email outbox kind (migration 0003)"
```

---
### Task 4: Real Uber adapter over `fetch` (OAuth token cache, quote, create delivery)

**Files:**
- Create: `src/adapters/uber-api.ts`, `src/store/uber.ts`, `tests/adapters/uber-api.test.ts`, `tests/store/uber.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Uber`, `QuoteRequest`, `UberQuote`, `DeliveryRequest`, `UberDelivery`, `UberError` (Task 1); `PostalAddress` (Task 2).
- Produces: `UberApi` and `encodeAddress(a)` (`src/adapters/uber-api.ts`); `TokenCache` and `tokenCache(db)` (`src/store/uber.ts`).

Every wire fact below was **verified from developer.uber.com on 2026-09-09** except the three marked otherwise; see this plan's Global Constraints for the full verified/unverified list.

- [ ] **Step 1: Write the failing token-cache test**

`tests/store/uber.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { tokenCache } from "../../src/store/uber";

describe("store/uber token cache", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM settings WHERE key = 'uber.token'").run(); });

  it("returns null when nothing is cached", async () => {
    expect(await tokenCache(env.DB).load()).toBeNull();
  });

  it("round-trips a token and its expiry", async () => {
    const c = tokenCache(env.DB);
    await c.save({ token: "at_1", expiresAt: 1_800_000_000 });
    expect(await c.load()).toEqual({ token: "at_1", expiresAt: 1_800_000_000 });
    await c.save({ token: "at_2", expiresAt: 1_900_000_000 });
    expect(await c.load()).toEqual({ token: "at_2", expiresAt: 1_900_000_000 });
  });

  it("clears the cached token", async () => {
    const c = tokenCache(env.DB);
    await c.save({ token: "at_1", expiresAt: 1_800_000_000 });
    await c.clear();
    expect(await c.load()).toBeNull();
  });

  it("survives a corrupt row rather than throwing", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('uber.token', 'not json')").run();
    expect(await tokenCache(env.DB).load()).toBeNull();
  });
});
```

- [ ] **Step 2: Implement the token cache**

`src/store/uber.ts`:

```ts
/**
 * The Uber access token lives in D1 `settings` under `uber.token` (D30). It is a 30-day
 * client-credentials bearer for the store's own Uber org, not a user credential, so unlike the
 * Google refresh token (D18) it is stored in the clear: encrypting it would buy nothing an
 * attacker with D1 access does not already have via UBER_CLIENT_SECRET's blast radius, and a
 * plaintext row can be read by a human debugging a courier problem. It is re-fetched on any 401.
 */
const KEY = "uber.token";

export interface CachedToken { token: string; expiresAt: number } // expiresAt: unix seconds
export interface TokenCache {
  load(): Promise<CachedToken | null>;
  save(t: CachedToken): Promise<void>;
  clear(): Promise<void>;
}

export function tokenCache(db: D1Database): TokenCache {
  return {
    async load() {
      const r = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(KEY).first<{ value_json: string }>();
      if (!r) return null;
      try {
        const v = JSON.parse(r.value_json) as CachedToken;
        return typeof v?.token === "string" && typeof v?.expiresAt === "number" ? v : null;
      } catch {
        console.error("uber: cached token row is not valid JSON; re-authenticating");
        return null;
      }
    },
    async save(t) {
      await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
        .bind(KEY, JSON.stringify(t)).run();
    },
    async clear() {
      await db.prepare("DELETE FROM settings WHERE key = ?").bind(KEY).run();
    },
  };
}
```

- [ ] **Step 3: Write the failing adapter tests**

`tests/adapters/uber-api.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { UberApi, encodeAddress } from "../../src/adapters/uber-api";
import { UberError, verifyUberSignature, type DeliveryWindow, type Party } from "../../src/adapters/uber";
import type { CachedToken, TokenCache } from "../../src/store/uber";

type Canned = { status: number; body: unknown };
function fakeFetch(script: Canned[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
    const next = script.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

function memoryCache(initial: CachedToken | null = null): TokenCache & { value: CachedToken | null } {
  const c = {
    value: initial,
    async load() { return c.value; },
    async save(t: CachedToken) { c.value = t; },
    async clear() { c.value = null; },
  };
  return c;
}

const TOKEN = { status: 200, body: { access_token: "at_1", expires_in: 2592000, token_type: "Bearer", scope: "eats.deliveries" } };

const STUDIO: Party = {
  name: "Anthony Demonia", phone: "+15183340517", businessName: "The Bull and Bloom",
  address: { street: "1 Warren Street", unit: "", city: "Hudson", state: "NY", zip: "12534" },
  notes: "Ring the studio bell",
};
const CUSTOMER: Party = {
  name: "Pat Smith", phone: "+15185550100",
  address: { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" },
  notes: "Leave on the porch",
};
const WINDOW: DeliveryWindow = {
  pickupReadyAt: new Date("2026-09-16T13:00:00.000Z"),
  pickupDeadlineAt: new Date("2026-09-16T14:00:00.000Z"),
  dropoffReadyAt: new Date("2026-09-16T14:00:00.000Z"),
  dropoffDeadlineAt: new Date("2026-09-16T15:30:00.000Z"),
};
const QUOTE_REQ = { pickup: STUDIO, dropoff: CUSTOMER, window: WINDOW, valueCents: 8500 };
const DELIVERY_REQ = {
  quoteId: "dqt_1", pickup: STUDIO, dropoff: CUSTOMER, window: WINDOW, valueCents: 8500,
  itemName: "Bouquet — hand-tied flowers", reference: "a1b2c3d4", idempotencyKey: "a1b2c3d4-order",
};

const api = (script: Canned[], cache = memoryCache(), robocourier = false) => {
  const { fn, calls } = fakeFetch(script);
  return { uber: new UberApi("cid", "csec", "cus_1", cache, robocourier, fn), calls, cache };
};

describe("encodeAddress", () => {
  it("emits Uber's JSON-encoded address string with street_address as an array", () => {
    expect(JSON.parse(encodeAddress({ street: "5 Elm Street", unit: "", city: "Hudson", state: "NY", zip: "12534" }))).toEqual({
      street_address: ["5 Elm Street"], city: "Hudson", state: "NY", zip_code: "12534", country: "US",
    });
  });
  it("puts a unit on the second street line", () => {
    expect(JSON.parse(encodeAddress({ street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" })).street_address)
      .toEqual(["5 Elm Street", "Apt 2"]);
  });
});

describe("UberApi", () => {
  it("reports configured only with all three client values", () => {
    const c = memoryCache();
    expect(new UberApi("id", "sec", "cus", c).configured()).toBe(true);
    expect(new UberApi(undefined, "sec", "cus", c).configured()).toBe(false);
    expect(new UberApi("id", "", "cus", c).configured()).toBe(false);
    expect(new UberApi("id", "sec", undefined, c).configured()).toBe(false);
  });

  it("throws unconfigured before any network call when secrets are absent", async () => {
    const { fn, calls } = fakeFetch([]);
    const u = new UberApi(undefined, undefined, undefined, memoryCache(), false, fn);
    await expect(u.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "unconfigured" });
    expect(calls).toHaveLength(0);
  });

  it("fetches a client-credentials token form-encoded and caches it", async () => {
    const { uber, calls, cache } = api([TOKEN, { status: 200, body: {
      kind: "delivery_quote", id: "dqt_9", created: "2026-09-09T19:00:37.887Z", expires: "2026-09-09T19:15:37.887Z",
      fee: 600, currency: "usd", currency_type: "USD", dropoff_eta: "2026-09-16T14:34:22.000Z",
      duration: 33, pickup_duration: 24,
    } }]);
    const q = await uber.quote(QUOTE_REQ);
    expect(calls[0].url).toBe("https://auth.uber.com/oauth/v2/token");
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(calls[0].body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("eats.deliveries");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csec");
    expect(q).toEqual({
      id: "dqt_9", feeCents: 600, currency: "usd",
      expiresAt: Math.floor(Date.parse("2026-09-09T19:15:37.887Z") / 1000),
      dropoffEtaAt: Math.floor(Date.parse("2026-09-16T14:34:22.000Z") / 1000),
    });
    expect(cache.value!.token).toBe("at_1");
  });

  it("reuses a cached token that is still fresh and never calls the auth endpoint", async () => {
    const cache = memoryCache({ token: "at_cached", expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    const { uber, calls } = api([{ status: 200, body: { id: "dqt_1", expires: "2026-09-09T19:15:37.887Z", fee: 600, currency: "usd" } }], cache);
    await uber.quote(QUOTE_REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.uber.com/v1/customers/cus_1/delivery_quotes");
    expect(calls[0].headers.authorization).toBe("Bearer at_cached");
  });

  it("re-authenticates once after a 401 and retries the call", async () => {
    const cache = memoryCache({ token: "at_stale", expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    const { uber, calls } = api([
      { status: 401, body: { code: "unauthorized", message: "no", kind: "error" } },
      TOKEN,
      { status: 200, body: { id: "dqt_2", expires: "2026-09-09T19:15:37.887Z", fee: 700, currency: "usd" } },
    ], cache);
    expect((await uber.quote(QUOTE_REQ)).feeCents).toBe(700);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.uber.com/v1/customers/cus_1/delivery_quotes",
      "https://auth.uber.com/oauth/v2/token",
      "https://api.uber.com/v1/customers/cus_1/delivery_quotes",
    ]);
    expect(cache.value!.token).toBe("at_1");
  });

  it("sends the documented quote body: encoded addresses, RFC 3339 window, value in cents", async () => {
    const { uber, calls } = api([TOKEN, { status: 200, body: { id: "dqt_3", expires: "2026-09-09T19:15:37.887Z", fee: 600, currency: "usd" } }]);
    await uber.quote(QUOTE_REQ);
    const body = JSON.parse(calls[1].body!);
    expect(body.pickup_address).toBe(encodeAddress(STUDIO.address));
    expect(body.dropoff_address).toBe(encodeAddress(CUSTOMER.address));
    expect(body.pickup_phone_number).toBe("+15183340517");
    expect(body.dropoff_phone_number).toBe("+15185550100");
    expect(body.pickup_ready_dt).toBe("2026-09-16T13:00:00.000Z");
    expect(body.pickup_deadline_dt).toBe("2026-09-16T14:00:00.000Z");
    expect(body.dropoff_ready_dt).toBe("2026-09-16T14:00:00.000Z");
    expect(body.dropoff_deadline_dt).toBe("2026-09-16T15:30:00.000Z");
    expect(body.manifest_total_value).toBe(8500);
  });

  it("maps Uber's undeliverable codes to code 'undeliverable' and everything else to 'unavailable'", async () => {
    for (const code of ["address_undeliverable", "unknown_location", "address_undeliverable_limited_couriers"]) {
      const { uber } = api([TOKEN, { status: 400, body: { code, message: "The specified location is not in a deliverable area.", kind: "error" } }]);
      await expect(uber.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "undeliverable" });
    }
    const { uber: u2 } = api([TOKEN, { status: 400, body: { code: "invalid_params", message: "bad", kind: "error" } }]);
    await expect(u2.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "unavailable" });
    const { uber: u3 } = api([TOKEN, { status: 500, body: { code: "internal_server_error", message: "boom", kind: "error" } }]);
    await expect(u3.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("creates a delivery with the quote id, manifest, idempotency key, and safe fallback actions", async () => {
    const { uber, calls } = api([TOKEN, { status: 200, body: {
      kind: "delivery", id: "del_7", quote_id: "dqt_1", status: "pending", fee: 1099, currency: "usd",
      tracking_url: "https://direct.uber.com/track/del_7", uuid: "abc", complete: false, live_mode: true,
    } }]);
    const d = await uber.createDelivery(DELIVERY_REQ);
    expect(d).toEqual({ id: "del_7", status: "pending", trackingUrl: "https://direct.uber.com/track/del_7", feeCents: 1099 });
    expect(calls[1].url).toBe("https://api.uber.com/v1/customers/cus_1/deliveries");
    const body = JSON.parse(calls[1].body!);
    expect(body.quote_id).toBe("dqt_1");
    expect(body.pickup_name).toBe("Anthony Demonia");
    expect(body.pickup_business_name).toBe("The Bull and Bloom");
    expect(body.pickup_notes).toBe("Ring the studio bell");
    expect(body.dropoff_name).toBe("Pat Smith");
    expect(body.dropoff_notes).toBe("Leave on the porch");
    expect(body.manifest_items).toEqual([{ name: "Bouquet — hand-tied flowers", quantity: 1, size: "small", price: 8500 }]);
    expect(body.manifest_reference).toBe("a1b2c3d4");
    expect(body.deliverable_action).toBe("deliverable_action_meet_at_door");
    expect(body.undeliverable_action).toBe("return");
    expect(body.idempotency_key).toBe("a1b2c3d4-order");
    expect(body.test_specifications).toBeUndefined();
  });

  it("adds the Robocourier block only in sandbox mode", async () => {
    const { uber, calls } = api([TOKEN, { status: 200, body: { id: "del_8", status: "pending", fee: 1099, tracking_url: "https://t.test/8" } }], memoryCache(), true);
    await uber.createDelivery(DELIVERY_REQ);
    expect(JSON.parse(calls[1].body!).test_specifications).toEqual({ robo_courier_specification: { mode: "auto" } });
  });

  it("surfaces a duplicate delivery as unavailable with Uber's message", async () => {
    const { uber } = api([TOKEN, { status: 409, body: { code: "duplicate_delivery", message: "already exists", kind: "error" } }]);
    await expect(uber.createDelivery(DELIVERY_REQ)).rejects.toThrow(/duplicate_delivery/);
  });

  it("rejects a response missing the fields we depend on rather than storing nonsense", async () => {
    const { uber } = api([TOKEN, { status: 200, body: { id: "del_9", status: "pending" } }]);
    await expect(uber.createDelivery(DELIVERY_REQ)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("verifyUberSignature", () => {
  // The docs' own worked example: this key over this payload yields this digest.
  const KEY = "c5c26d5a-70d6-46c7-a652-d7c09825ad29";
  const PAYLOAD = '{"kind": "event.courier_update", "location": {"lat": 37.7974109, "lng": -122.424145}}';
  const SIG = "cdff8133fb065f8d37a2c1c94c3331b6a82766d14e7ea4faacc4886558cedd65";

  it("accepts the signature from Uber's documented example", async () => {
    expect(await verifyUberSignature(KEY, PAYLOAD, SIG)).toBe(true);
  });
  it("accepts an uppercase or padded header", async () => {
    expect(await verifyUberSignature(KEY, PAYLOAD, ` ${SIG.toUpperCase()} `)).toBe(true);
  });
  it("rejects a tampered body, a wrong key, and a missing header", async () => {
    expect(await verifyUberSignature(KEY, `${PAYLOAD} `, SIG)).toBe(false);
    expect(await verifyUberSignature("other-key", PAYLOAD, SIG)).toBe(false);
    expect(await verifyUberSignature(KEY, PAYLOAD, undefined)).toBe(false);
    expect(await verifyUberSignature("", PAYLOAD, SIG)).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run tests/adapters/uber-api.test.ts tests/store/uber.test.ts`
Expected: FAIL — `Cannot find module '../../src/adapters/uber-api'`.

- [ ] **Step 5: Implement the adapter**

`src/adapters/uber-api.ts`:

```ts
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
  }

  async createDelivery(req: DeliveryRequest): Promise<UberDelivery> {
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
      // Hand a $85 perishable to a person, and bring it home rather than bin it if nobody answers.
      deliverable_action: "deliverable_action_meet_at_door",
      undeliverable_action: "return",
      idempotency_key: req.idempotencyKey,
      external_id: req.reference,
    };
    if (this.robocourier) body.test_specifications = { robo_courier_specification: { mode: "auto" } };

    const r = await this.api<DeliveryResponse>(`/customers/${this.customerId}/deliveries`, body);
    if (typeof r.id !== "string" || typeof r.status !== "string" || typeof r.tracking_url !== "string" || typeof r.fee !== "number") {
      throw new UberError("unavailable", `uber: delivery response missing id, status, tracking_url or fee: ${JSON.stringify(r).slice(0, 200)}`);
    }
    return { id: r.id, status: r.status, trackingUrl: r.tracking_url, feeCents: r.fee };
  }

  /** Client-credentials token, cached in D1 across isolates (D30). Uber allows 100 of these an hour. */
  private async accessToken(force = false): Promise<string> {
    if (!this.configured()) throw new UberError("unconfigured", "uber: not configured");
    const nowSec = Math.floor(Date.now() / 1000);
    if (!force) {
      const hit = await this.cache.load();
      if (hit && hit.expiresAt - TOKEN_SKEW_SECONDS > nowSec) return hit.token;
    }
    const form = new URLSearchParams({
      client_id: this.clientId!, client_secret: this.clientSecret!,
      grant_type: "client_credentials", scope: SCOPE,
    });
    const res = await this.fetchFn(AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new UberError("unavailable", `uber token ${res.status}: ${text.slice(0, 300)}`);
    let t: TokenResponse;
    try { t = JSON.parse(text) as TokenResponse; }
    catch { throw new UberError("unavailable", `uber token: response was not JSON: ${text.slice(0, 200)}`); }
    if (typeof t.access_token !== "string") throw new UberError("unavailable", "uber token: no access_token in response");
    // Uber's documented lifetime is 2592000s (30 days); trust whatever it actually says.
    const lifetime = Number.isFinite(t.expires_in) ? t.expires_in : 2592000;
    await this.cache.save({ token: t.access_token, expiresAt: nowSec + lifetime });
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
```

- [ ] **Step 6: Replace the stub in `servicesFor`**

In `src/index.ts`, delete the Task 1 stub and construct the real adapter:

```ts
import { UberApi } from "./adapters/uber-api";
import { tokenCache } from "./store/uber";
```

```ts
export function servicesFor(env: Env): Services {
  if (!services) {
    const payments = new StripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
    const google = new GoogleApi(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, connectionSource(env.DB, env.ADMIN_SECRET));
    const uber = new UberApi(
      env.UBER_CLIENT_ID, env.UBER_CLIENT_SECRET, env.UBER_CUSTOMER_ID,
      tokenCache(env.DB), env.UBER_ROBOCOURIER === "1",
    );
    services = { payments, google, uber, clock: () => new Date(), config: loadConfig() };
  }
  return services;
}
```

The `UberError`/`Uber` type imports the stub needed can go.

- [ ] **Step 7: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/adapters/uber-api.test.ts tests/store/uber.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/uber-api.ts src/store/uber.ts src/index.ts tests/adapters/uber-api.test.ts tests/store/uber.test.ts
git commit -m "feat(uber): real Direct API adapter — cached client-credentials token, quote, create delivery"
```

---
### Task 5: Delivery core (window, address, fallback, signed quote) and `POST /api/quote`

**Files:**
- Create: `src/core/delivery.ts`, `src/core/quote-token.ts`, `tests/core/delivery.test.ts`, `tests/core/quote-token.test.ts`
- Modify: `src/routes/public.ts`, `tests/routes/public.test.ts`

**Interfaces:**
- Consumes: `DeliveryWindow`, `Uber`, `UberError` (Task 1); `PostalAddress`, `StoreConfig` (Task 2); `instantAt` (Task 2).
- Produces (`src/core/delivery.ts`): `MAX_SCHEDULE_DAYS`, `deliveryWindow(pickupReadyAt, now)`, `pickupReadyFor(cfg, date, now)`, `parseAddress(raw)`, `addressKey(a)`, `fallbackFeeFor(cfg, zip)`, `deliveryItemName(sizeName)`.
- Produces (`src/core/quote-token.ts`): `QuoteClaim`, `signQuote(secret, claim)`, `verifyQuote(secret, token, nowSec)`.
- Produces (routes): `POST /api/quote` returning `{ available: true, feeCents, kind, quoteToken }` or `{ available: false, reason }`; `GET /api/config` gains `delivery: { offered: boolean }`.

- [ ] **Step 1: Write the failing core tests**

`tests/core/delivery.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  MAX_SCHEDULE_DAYS, addressKey, deliveryItemName, deliveryWindow, fallbackFeeFor, parseAddress, pickupReadyFor,
} from "../../src/core/delivery";
import { loadConfig } from "../../src/config";

const cfg = loadConfig();
const min = (n: number) => n * 60_000;

describe("deliveryWindow", () => {
  it("satisfies every Uber constraint for a future pickup", () => {
    const now = new Date("2026-09-15T13:00:00Z");
    const ready = new Date("2026-09-16T13:00:00Z");
    const w = deliveryWindow(ready, now);
    expect(w.pickupReadyAt.toISOString()).toBe("2026-09-16T13:00:00.000Z");
    expect(+w.pickupDeadlineAt - +w.pickupReadyAt).toBeGreaterThanOrEqual(min(10));
    expect(+w.pickupDeadlineAt - +now).toBeGreaterThanOrEqual(min(20));
    expect(+w.dropoffReadyAt).toBeLessThanOrEqual(+w.pickupDeadlineAt);
    expect(+w.dropoffDeadlineAt - +w.dropoffReadyAt).toBeGreaterThanOrEqual(min(20));
    expect(+w.dropoffDeadlineAt).toBeGreaterThanOrEqual(+w.pickupDeadlineAt);
  });

  it("never asks for a pickup in the past, and still clears the 20-minute deadline floor", () => {
    const now = new Date("2026-09-16T18:00:00Z");
    const ready = new Date("2026-09-16T13:00:00Z"); // this morning's ready time, already gone
    const w = deliveryWindow(ready, now);
    expect(+w.pickupReadyAt).toBe(+now);
    expect(+w.pickupDeadlineAt - +now).toBeGreaterThanOrEqual(min(20));
  });

  it("holds the deadline floor even when the pickup window would be too soon", () => {
    const now = new Date("2026-09-16T18:00:00Z");
    const w = deliveryWindow(new Date("2026-09-16T18:01:00Z"), now);
    expect(+w.pickupDeadlineAt - +now).toBeGreaterThanOrEqual(min(20));
  });
});

describe("pickupReadyFor", () => {
  it("schedules for the studio ready time on the order date, in studio time", () => {
    const now = new Date("2026-09-15T13:00:00Z");
    const r = pickupReadyFor(cfg, "2026-09-16", now);
    expect(r.scheduled).toBe(true);
    // 09:00 America/New_York on 2026-09-16 is 13:00 UTC (EDT).
    expect(r.at.toISOString()).toBe("2026-09-16T13:00:00.000Z");
  });

  it("falls back to an ASAP estimate beyond Uber's 30-day scheduling limit", () => {
    const now = new Date("2026-09-15T13:00:00Z");
    const far = new Date(+now + (MAX_SCHEDULE_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);
    const r = pickupReadyFor(cfg, far, now);
    expect(r.scheduled).toBe(false);
    expect(+r.at).toBe(+now);
  });
});

describe("parseAddress", () => {
  const good = { street: " 5 Elm Street ", unit: " Apt 2 ", city: " Hudson ", state: "ny", zip: "12534" };

  it("trims, upper-cases the state, and keeps the unit optional", () => {
    const r = parseAddress(good);
    expect(r.ok && r.address).toEqual({ street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" });
    const noUnit = parseAddress({ ...good, unit: undefined });
    expect(noUnit.ok && noUnit.address.unit).toBe("");
  });

  it("rejects every missing or malformed field with a message a person can act on", () => {
    expect(parseAddress(null)).toEqual({ ok: false, error: "address required" });
    expect(parseAddress({ ...good, street: "" })).toEqual({ ok: false, error: "street address required" });
    expect(parseAddress({ ...good, city: "  " })).toEqual({ ok: false, error: "city required" });
    expect(parseAddress({ ...good, state: "New York" })).toEqual({ ok: false, error: "state must be a two-letter code" });
    expect(parseAddress({ ...good, zip: "1253" })).toEqual({ ok: false, error: "zip must be five digits" });
    expect(parseAddress({ ...good, street: "x".repeat(201) })).toEqual({ ok: false, error: "street address is too long" });
  });
});

describe("addressKey", () => {
  it("is stable across case and spacing so a re-typed address keeps its quote", () => {
    const a = { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" };
    const b = { street: "5 elm street", unit: "apt 2", city: "HUDSON", state: "NY", zip: "12534" };
    expect(addressKey(a)).toBe(addressKey(b));
    expect(addressKey({ ...a, zip: "12535" })).not.toBe(addressKey(a));
  });
});

describe("fallbackFeeFor", () => {
  it("returns the flat fee for a listed zip and null for anything else", () => {
    expect(fallbackFeeFor(cfg, cfg.delivery.fallbackZips[0])).toBe(cfg.delivery.fallbackFeeCents);
    expect(fallbackFeeFor(cfg, "99999")).toBeNull();
  });
  it("returns null for every zip when the list is empty", () => {
    expect(fallbackFeeFor({ ...cfg, delivery: { fallbackFeeCents: 1500, fallbackZips: [] } }, "12534")).toBeNull();
  });
});

describe("deliveryItemName", () => {
  it("names the parcel for the courier without revealing the customer", () => {
    expect(deliveryItemName("Bouquet")).toBe("Bouquet — hand-tied flowers");
  });
});
```

`tests/core/quote-token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signQuote, verifyQuote, type QuoteClaim } from "../../src/core/quote-token";

const SECRET = "test-secret";
const claim: QuoteClaim = {
  feeCents: 1200, quoteId: "dqt_1", kind: "uber", date: "2026-09-16",
  addr: "5 elm street|apt 2|hudson|ny|12534", exp: 1_800_000_900,
};

describe("quote token", () => {
  it("round-trips a claim before it expires", async () => {
    const t = await signQuote(SECRET, claim);
    expect(await verifyQuote(SECRET, t, 1_800_000_000)).toEqual(claim);
  });
  it("refuses an expired token", async () => {
    const t = await signQuote(SECRET, claim);
    expect(await verifyQuote(SECRET, t, 1_800_000_901)).toBeNull();
  });
  it("refuses a token signed with another secret", async () => {
    const t = await signQuote("other", claim);
    expect(await verifyQuote(SECRET, t, 1_800_000_000)).toBeNull();
  });
  it("refuses a token whose fee was edited in the browser", async () => {
    const t = await signQuote(SECRET, claim);
    const [payload, sig] = t.split(".");
    const edited = btoa(JSON.stringify({ ...claim, feeCents: 1 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyQuote(SECRET, `${edited}.${sig}`, 1_800_000_000)).toBeNull();
    expect(await verifyQuote(SECRET, payload, 1_800_000_000)).toBeNull();
  });
  it("refuses garbage without throwing", async () => {
    expect(await verifyQuote(SECRET, "", 1)).toBeNull();
    expect(await verifyQuote(SECRET, "no-dot", 1)).toBeNull();
    expect(await verifyQuote(SECRET, "!!!.???", 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/core/delivery.test.ts tests/core/quote-token.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement the delivery core**

`src/core/delivery.ts`:

```ts
import type { DeliveryWindow } from "../adapters/uber";
import type { PostalAddress, StoreConfig } from "../config";
import { instantAt } from "./time";

const MIN = 60_000;
/** Uber requires pickup_ready_dt to be less than 30 days out; stay a day clear of the edge. */
export const MAX_SCHEDULE_DAYS = 29;
/** How long after the ready time the courier may still collect. Uber's floor is 10 minutes. */
const PICKUP_WINDOW_MIN = 60;
/** Uber requires pickup_deadline_dt at least 20 minutes from now; 25 absorbs clock skew. */
const DEADLINE_FLOOR_MIN = 25;
/** How long after collection the courier has to arrive. Uber's floor is 20 minutes. */
const DROPOFF_WINDOW_MIN = 90;

/**
 * The four timestamps Uber wants, built so every documented constraint holds:
 * pickupDeadline >= pickupReady + 10 min and >= now + 20 min; dropoffReady <= pickupDeadline;
 * dropoffDeadline >= dropoffReady + 20 min and >= pickupDeadline. A ready time already in the
 * past (a same-day order placed after the studio's ready hour) becomes "now".
 */
export function deliveryWindow(pickupReadyAt: Date, now: Date): DeliveryWindow {
  const ready = Math.max(+pickupReadyAt, +now);
  const deadline = Math.max(ready + PICKUP_WINDOW_MIN * MIN, +now + DEADLINE_FLOOR_MIN * MIN);
  return {
    pickupReadyAt: new Date(ready),
    pickupDeadlineAt: new Date(deadline),
    dropoffReadyAt: new Date(deadline),
    dropoffDeadlineAt: new Date(deadline + DROPOFF_WINDOW_MIN * MIN),
  };
}

/**
 * When the courier should collect for an order on `date`: the studio's ready time in studio
 * time. Beyond Uber's 30-day scheduling limit there is no way to ask about that day, so we
 * quote an ASAP job instead and tell the caller the fee is an estimate (`scheduled: false`).
 * The storefront only offers 28 days, so this branch is a safety net, not a normal path.
 */
export function pickupReadyFor(cfg: StoreConfig, date: string, now: Date): { at: Date; scheduled: boolean } {
  const at = instantAt(cfg.timezone, date, cfg.studio.readyTime);
  if (+at > +now + MAX_SCHEDULE_DAYS * 86_400_000) return { at: now, scheduled: false };
  return { at, scheduled: true };
}

export type ParsedAddress = { ok: true; address: PostalAddress } | { ok: false; error: string };

/** Validate and normalise an address off the wire. Never throws. */
export function parseAddress(raw: unknown): ParsedAddress {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return { ok: false, error: "address required" };
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const street = s(a.street), unit = s(a.unit), city = s(a.city), state = s(a.state).toUpperCase(), zip = s(a.zip);
  if (street === "") return { ok: false, error: "street address required" };
  if (street.length > 200) return { ok: false, error: "street address is too long" };
  if (unit.length > 100) return { ok: false, error: "unit is too long" };
  if (city === "") return { ok: false, error: "city required" };
  if (city.length > 100) return { ok: false, error: "city is too long" };
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, error: "state must be a two-letter code" };
  if (!/^\d{5}$/.test(zip)) return { ok: false, error: "zip must be five digits" };
  return { ok: true, address: { street, unit, city, state, zip } };
}

/** A stable fingerprint of an address, so a quote can be bound to the address it priced. */
export function addressKey(a: PostalAddress): string {
  return [a.street, a.unit, a.city, a.state, a.zip].map((v) => v.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
}

/** The flat fee for a zip on the repo's fallback list, or null when the zip is not on it (spec §4.2). */
export function fallbackFeeFor(cfg: StoreConfig, zip: string): number | null {
  return cfg.delivery.fallbackZips.includes(zip) ? cfg.delivery.fallbackFeeCents : null;
}

/** What the courier's manifest says is in the box. No customer detail — couriers see the manifest. */
export function deliveryItemName(sizeName: string): string {
  return `${sizeName} — hand-tied flowers`;
}
```

- [ ] **Step 4: Implement the quote token**

`src/core/quote-token.ts`:

```ts
/**
 * A delivery fee the browser cannot edit (D31). `/api/quote` signs what it priced; `/api/checkout`
 * verifies the signature, that the token still lives, and that it covers the address and date being
 * bought. Without this, checkout would have to either trust a number posted by the browser or make
 * a second Uber call whose answer could differ from the one the customer just agreed to.
 */
export interface QuoteClaim {
  feeCents: number;
  /** Uber's quote id, or null for a config fallback quote */
  quoteId: string | null;
  kind: "uber" | "fallback";
  /** the order date the quote was priced for */
  date: string;
  /** addressKey() of the address it was priced for */
  addr: string;
  /** unix seconds */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function mac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`quote:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export async function signQuote(secret: string, claim: QuoteClaim): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claim)));
  return `${payload}.${await mac(secret, payload)}`;
}

/** The claim if the token is authentic and unexpired, else null. Never throws. */
export async function verifyQuote(secret: string, token: string, nowSec: number): Promise<QuoteClaim | null> {
  const i = token.indexOf(".");
  if (i <= 0) return null;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  let expected: string;
  try { expected = await mac(secret, payload); } catch { return null; }
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let k = 0; k < sig.length; k++) diff |= sig.charCodeAt(k) ^ expected.charCodeAt(k);
  if (diff !== 0) return null;
  try {
    const claim = JSON.parse(dec.decode(unb64url(payload))) as QuoteClaim;
    if (typeof claim?.feeCents !== "number" || typeof claim?.exp !== "number") return null;
    if (claim.exp <= nowSec) return null;
    return claim;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Write the failing route tests**

Add to `tests/routes/public.test.ts`:

```ts
const address = { street: "5 Elm Street", unit: "", city: "Hudson", state: "NY", zip: "12534" };
const outside = { ...address, zip: "10001" };
const quoteFor = (fetch: any, body: unknown) =>
  fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/quote", () => {
  it("prices a delivery from Uber, scheduled for the studio ready time on the order date", async () => {
    const { fetch, uber } = testApp();
    uber.quoteFee = 1350;
    const r = await quoteFor(fetch, { date: "2026-09-16", address });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body).toMatchObject({ available: true, feeCents: 1350, kind: "uber" });
    expect(typeof body.quoteToken).toBe("string");
    // 09:00 America/New_York on 2026-09-16 == 13:00 UTC
    expect(uber.quoted[0].window.pickupReadyAt.toISOString()).toBe("2026-09-16T13:00:00.000Z");
    expect(uber.quoted[0].dropoff.address.zip).toBe("12534");
    expect(uber.quoted[0].valueCents).toBeGreaterThan(0);
  });

  it("offers the flat fallback fee for a listed zip when Uber says the address is undeliverable", async () => {
    const { fetch, uber } = testApp();
    uber.failWith("undeliverable", "not in a deliverable area");
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address })).json() as any;
    expect(body).toMatchObject({ available: true, kind: "fallback" });
    expect(body.feeCents).toBe(loadConfig().delivery.fallbackFeeCents);
  });

  it("offers the fallback when Uber is not configured at all", async () => {
    const { fetch, uber } = testApp();
    uber.isConfigured = false;
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address })).json() as any;
    expect(body).toMatchObject({ available: true, kind: "fallback" });
    expect(uber.quoted).toHaveLength(0);
  });

  it("says outside_area when Uber refuses and the zip is not on the fallback list", async () => {
    const { fetch, uber } = testApp();
    uber.failWith("undeliverable", "nope");
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address: outside })).json() as any;
    expect(body).toEqual({ available: false, reason: "outside_area" });
  });

  it("says unavailable when Uber breaks and there is no fallback for the zip", async () => {
    const { fetch, uber } = testApp();
    uber.failWith("unavailable", "uber 500");
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address: outside })).json() as any;
    expect(body).toEqual({ available: false, reason: "unavailable" });
  });

  it("validates the date and the address", async () => {
    const { fetch } = testApp();
    expect((await quoteFor(fetch, { date: "nope", address })).status).toBe(400);
    expect((await quoteFor(fetch, { date: "2026-09-16", address: { ...address, zip: "abc" } })).status).toBe(400);
    expect((await quoteFor(fetch, { date: "2099-01-01", address })).status).toBe(400);
    expect((await fetch("/api/quote", { method: "POST", body: "not json" })).status).toBe(400);
  });
});
```

and extend the existing `/api/config` test:

```ts
    expect(body.delivery).toEqual({ offered: true });
```

(add `import { loadConfig } from "../../src/config";` to that file's imports.)

- [ ] **Step 6: Implement the route**

In `src/routes/public.ts`, add the imports:

```ts
import { UberError } from "../adapters/uber";
import { addressKey, deliveryWindow, fallbackFeeFor, parseAddress, pickupReadyFor } from "../core/delivery";
import { signQuote } from "../core/quote-token";
```

Add above `publicRoutes`:

```ts
/** How long a signed quote is honoured. Uber's own quotes live about 15 minutes. */
const QUOTE_TTL_SECONDS = 15 * 60;
/** A config fallback fee does not expire in any real sense; half an hour keeps a stale tab honest. */
const FALLBACK_TTL_SECONDS = 30 * 60;
/** The value we declare to the courier when no size has been chosen yet: the cheapest bouquet. */
function lowestPriceCents(cfg: { sizes: Array<{ priceCents: number }> }): number {
  return Math.min(...cfg.sizes.map((s) => s.priceCents));
}

/** True when a customer can be shown a delivery option at all (spec §4.5). */
function deliveryOffered(uberConfigured: boolean, cfg: { delivery: { fallbackZips: string[] } }): boolean {
  return uberConfigured || cfg.delivery.fallbackZips.length > 0;
}
```

Extend `/api/config`:

```ts
  r.get("/api/config", (c) => {
    const { config, uber } = c.get("services");
    return c.json({
      timezone: config.timezone,
      sizes: config.sizes,
      studio: { pickupInstructions: config.studio.pickupInstructions },
      delivery: { offered: deliveryOffered(uber.configured(), config) },
    });
  });
```

And add the quote route after `/api/availability`:

```ts
  r.post("/api/quote", async (c) => {
    const { config, clock, uber } = c.get("services");
    let raw: any;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (!isYmd(raw?.date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    const parsed = parseAddress(raw?.address);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const now = clock();
    const today = ymdIn(config.timezone, now);
    if (raw.date < today || raw.date > addDays(today, MAX_DAYS)) return c.json({ error: "date is outside the ordering window" }, 400);

    const nowSec = Math.floor(now.getTime() / 1000);
    const addr = addressKey(parsed.address);
    const value = lowestPriceCents(config);

    if (uber.configured()) {
      const ready = pickupReadyFor(config, raw.date, now);
      try {
        const q = await uber.quote({
          pickup: {
            name: "The Bull and Bloom", phone: config.studio.phone,
            businessName: "The Bull and Bloom", address: config.studio.address,
          },
          dropoff: { name: "Customer", phone: config.studio.phone, address: parsed.address },
          window: deliveryWindow(ready.at, now),
          valueCents: value,
        });
        const exp = Math.min(q.expiresAt, nowSec + QUOTE_TTL_SECONDS);
        const quoteToken = await signQuote(c.env.ADMIN_SECRET, {
          feeCents: q.feeCents, quoteId: q.id, kind: "uber", date: raw.date, addr, exp,
        });
        return c.json({ available: true, feeCents: q.feeCents, kind: "uber", quoteToken });
      } catch (err) {
        const code = err instanceof UberError ? err.code : "unavailable";
        console.error(`quote: uber ${code}`, err);
        const fee = fallbackFeeFor(config, parsed.address.zip);
        if (fee === null) return c.json({ available: false, reason: code === "undeliverable" ? "outside_area" : "unavailable" });
        return c.json({
          available: true, feeCents: fee, kind: "fallback",
          quoteToken: await signQuote(c.env.ADMIN_SECRET, {
            feeCents: fee, quoteId: null, kind: "fallback", date: raw.date, addr, exp: nowSec + FALLBACK_TTL_SECONDS,
          }),
        });
      }
    }

    const fee = fallbackFeeFor(config, parsed.address.zip);
    if (fee === null) return c.json({ available: false, reason: "outside_area" });
    return c.json({
      available: true, feeCents: fee, kind: "fallback",
      quoteToken: await signQuote(c.env.ADMIN_SECRET, {
        feeCents: fee, quoteId: null, kind: "fallback", date: raw.date, addr, exp: nowSec + FALLBACK_TTL_SECONDS,
      }),
    });
  });
```

Two notes for the implementer. The dropoff phone here is the studio's, not the customer's: a quote only prices a route, the customer has not given a phone yet at quote time, and Uber's schema requires a well-formed `+1…` number — the real customer number goes on the delivery itself in Task 8. And `valueCents` is the cheapest size because the customer may not have chosen one yet; `manifest_total_value` only sets the courier's declared value, and the real order value is sent at dispatch.

- [ ] **Step 7: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/core/delivery.test.ts tests/core/quote-token.test.ts tests/routes/public.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/core/delivery.ts src/core/quote-token.ts src/routes/public.ts tests/core tests/routes/public.test.ts
git commit -m "feat(delivery): POST /api/quote — scheduled Uber quote, flat-fee fallback, signed fee token"
```

---
### Task 6: Checkout with delivery — locked fee, address, second Stripe line item

**Files:**
- Modify: `src/core/delivery.ts`, `src/routes/public.ts`, `tests/core/delivery.test.ts`, `tests/routes/public.test.ts`

**Interfaces:**
- Consumes: `verifyQuote` and `QuoteClaim` (Task 5); `addressKey`, `parseAddress` (Task 5); `NewOrder` with `addressJson` and `uberQuoteId` (Task 3).
- Produces: `normalizePhone(raw)` in `src/core/delivery.ts`; `POST /api/checkout` accepting `fulfillment: "pickup" | "delivery"` with a `delivery: { address, notes?, quoteToken }` block; `orders.delivery_cents`, `orders.address_json` and `orders.uber_quote_id` populated for delivery orders.

- [ ] **Step 1: Write the failing phone test**

Add to `tests/core/delivery.test.ts`:

```ts
import { normalizePhone } from "../../src/core/delivery";

describe("normalizePhone", () => {
  it("turns the ways people type a US number into E.164", () => {
    for (const raw of ["518-555-0100", "(518) 555-0100", "5185550100", "1 518 555 0100", "+1 (518) 555-0100"]) {
      expect(normalizePhone(raw)).toBe("+15185550100");
    }
  });
  it("keeps an already-international number", () => {
    expect(normalizePhone("+442071838750")).toBe("+442071838750");
  });
  it("returns null for anything it cannot make sense of", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("555-0100")).toBeNull();
    expect(normalizePhone("call the shop")).toBeNull();
    expect(normalizePhone("+1")).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing checkout tests**

Add to `tests/routes/public.test.ts`. `deliveryBody` builds a full delivery checkout by first asking for a real quote token, exactly as the browser does:

```ts
async function deliveryBody(fetch: any, over: Record<string, unknown> = {}) {
  const q = await (await fetch("/api/quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-09-23", address }),
  })).json() as any;
  return {
    sizeId: "bouquet", date: "2026-09-23", fulfillment: "delivery",
    customer: { name: "Pat Lee", email: "pat@example.com", phone: "(518) 555-0100" },
    note: "yellows please",
    delivery: { address, notes: "porch, behind the planter", quoteToken: q.quoteToken },
    ...over,
  };
}

describe("POST /api/checkout — delivery", () => {
  it("locks the quoted fee on the order, stores the address, and adds a Delivery line item", async () => {
    const { fetch, payments, uber } = testApp();
    uber.quoteFee = 1350;
    const r = await post(fetch, await deliveryBody(fetch));
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems).toEqual([
      { name: "Bouquet — delivery Wed Sep 23", amountCents: 8500, quantity: 1 },
      { name: "Delivery — Wed Sep 23", amountCents: 1350, quantity: 1 },
    ]);
    const row = await env.DB.prepare(
      "SELECT fulfillment, delivery_cents, uber_quote_id, customer_phone, address_json FROM orders WHERE id = ?",
    ).bind(c.orderId).first<any>();
    expect(row.fulfillment).toBe("delivery");
    expect(row.delivery_cents).toBe(1350);
    expect(row.uber_quote_id).toBe("dqt_fake_1");
    expect(row.customer_phone).toBe("+15185550100");
    expect(JSON.parse(row.address_json)).toEqual({
      street: "5 Elm Street", unit: "", city: "Hudson", state: "NY", zip: "12534",
      notes: "porch, behind the planter",
    });
  });

  it("refuses a delivery order with no phone", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch, { customer: { name: "Pat Lee", email: "pat@example.com" } });
    const r = await post(fetch, body);
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/phone/);
  });

  it("refuses a phone it cannot dial", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch, { customer: { name: "Pat Lee", email: "pat@example.com", phone: "call me" } });
    expect((await post(fetch, body)).status).toBe(400);
  });

  it("refuses a fee the browser edited: the token, not the body, carries the price", async () => {
    const { fetch, payments } = testApp();
    const body = await deliveryBody(fetch);
    const before = payments.created.length;
    const r = await post(fetch, { ...body, deliveryCents: 1, delivery: { ...(body as any).delivery, feeCents: 1 } });
    // The extra fields are simply ignored; the order is created at the signed fee.
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(payments.created.length).toBe(before + 1);
    expect(c.lineItems[1].amountCents).toBe(1200);
  });

  it("rejects a quote for a different address or a different day", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch);
    expect((await post(fetch, { ...body, date: "2026-09-24" })).status).toBe(409);
    const moved = { ...(body as any).delivery, address: { ...address, street: "9 Oak Street" } };
    expect((await post(fetch, { ...body, delivery: moved })).status).toBe(409);
  });

  it("rejects a forged or expired token with quote_expired", async () => {
    const { fetch } = testApp();
    const body = await deliveryBody(fetch);
    const r = await post(fetch, { ...body, delivery: { ...(body as any).delivery, quoteToken: "forged.token" } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "quote_expired" });
  });

  it("still accepts a pickup order with no delivery block, unchanged from Plan 1", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, { ...good, date: "2026-09-25" });
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems).toEqual([{ name: "Bouquet — pickup Fri Sep 25", amountCents: 8500, quantity: 1 }]);
    const row = await env.DB.prepare("SELECT delivery_cents, address_json FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ delivery_cents: 0, address_json: null });
  });
});
```

Plan 1's existing test `"validates input"` asserts that `fulfillment: "delivery"` is a 400. Delivery is now legal, so change that line to assert the new failure mode — a delivery with no delivery block:

```ts
    expect((await post(fetch, { ...good, fulfillment: "delivery" })).status).toBe(400);
```

stays as written (a `delivery` block is missing, so it is still a 400) — no edit needed, but re-read the assertion when it passes to be sure it fails for the new reason and not the old one.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/core/delivery.test.ts tests/routes/public.test.ts`
Expected: FAIL — `normalizePhone` is not exported and delivery checkouts 400.

- [ ] **Step 4: Add `normalizePhone` to the delivery core**

Append to `src/core/delivery.ts`:

```ts
/**
 * E.164 or nothing. Uber's phone fields match `^\+[0-9]+$` and reject anything else, so a number
 * typed as "(518) 555-0100" has to be converted before it ever reaches a delivery request.
 * A bare 10-digit number is assumed to be US (+1); that is the only country the studio serves.
 */
export function normalizePhone(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
```

- [ ] **Step 5: Widen the checkout route**

In `src/routes/public.ts`, replace `CheckoutBody` and `parseCheckout` with:

```ts
interface DeliveryBody { address: PostalAddress; notes?: string; quoteToken: string }
interface CheckoutBody {
  sizeId: string; date: string; fulfillment: "pickup" | "delivery";
  customer: { name: string; email: string; phone?: string }; note?: string;
  delivery?: DeliveryBody;
}

function parseCheckout(raw: unknown): { ok: true; body: CheckoutBody } | { ok: false; error: string } {
  const b = raw as any;
  if (!b || typeof b !== "object") return { ok: false, error: "body must be an object" };
  if (typeof b.sizeId !== "string") return { ok: false, error: "sizeId required" };
  if (!isYmd(b.date)) return { ok: false, error: "date must be YYYY-MM-DD" };
  if (b.fulfillment !== "pickup" && b.fulfillment !== "delivery") return { ok: false, error: "fulfillment must be pickup or delivery" };
  const c = b.customer;
  if (!c || typeof c.name !== "string" || c.name.trim().length < 1 || c.name.trim().length > 120) return { ok: false, error: "name required" };
  if (typeof c.email !== "string" || !EMAIL.test(c.email) || c.email.length > 200) return { ok: false, error: "valid email required" };
  if (c.phone !== undefined && (typeof c.phone !== "string" || c.phone.length > 40)) return { ok: false, error: "phone too long" };
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) return { ok: false, error: "note must be 500 characters or fewer" };

  let delivery: DeliveryBody | undefined;
  if (b.fulfillment === "delivery") {
    const d = b.delivery;
    if (!d || typeof d !== "object") return { ok: false, error: "delivery details required" };
    if (typeof d.quoteToken !== "string" || d.quoteToken === "") return { ok: false, error: "a delivery price is required" };
    const addr = parseAddress(d.address);
    if (!addr.ok) return { ok: false, error: addr.error };
    if (d.notes !== undefined && (typeof d.notes !== "string" || d.notes.length > 280)) return { ok: false, error: "delivery instructions must be 280 characters or fewer" };
    // Uber needs a number the courier can call; Plan 1 left the phone optional for pickup.
    if (normalizePhone(c.phone) === null) return { ok: false, error: "a phone number we can dial is required for delivery" };
    delivery = { address: addr.address, notes: d.notes?.trim() || undefined, quoteToken: d.quoteToken };
  }

  return { ok: true, body: {
    sizeId: b.sizeId, date: b.date, fulfillment: b.fulfillment,
    customer: { name: c.name.trim(), email: c.email.trim(), phone: c.phone?.trim() || undefined },
    note: b.note?.trim() || undefined, delivery } };
}
```

with `import type { PostalAddress } from "../config";` and `import { normalizePhone, ... } from "../core/delivery";` and `import { signQuote, verifyQuote } from "../core/quote-token";` added.

Inside the `/api/checkout` handler, after the `isOrderable` guard and before the insert, resolve the delivery fee, then feed it into the insert and the line items. Replace the block from `const nowSec = …` through the `payments.createCheckout` call with:

```ts
    const nowSec = Math.floor(now.getTime() / 1000);

    let deliveryCents = 0;
    let addressJson: string | null = null;
    let uberQuoteId: string | null = null;
    let phone = body.customer.phone ?? null;

    if (body.fulfillment === "delivery") {
      const d = body.delivery!;
      const claim = await verifyQuote(c.env.ADMIN_SECRET, d.quoteToken, nowSec);
      if (!claim) return c.json({ error: "quote_expired" }, 409);
      if (claim.date !== body.date || claim.addr !== addressKey(d.address)) {
        // The customer changed the day or the address after we priced it; the storefront asks again.
        return c.json({ error: "quote_expired" }, 409);
      }
      // D8: this fee is the one the customer pays, whatever the courier costs on the day.
      deliveryCents = claim.feeCents;
      uberQuoteId = claim.quoteId;
      addressJson = JSON.stringify({ ...d.address, notes: d.notes ?? "" });
      phone = normalizePhone(body.customer.phone);
    }

    // D16: pad Stripe's own expiry 60s past the nominal hold window, and let our hold outlive
    // the Stripe session by a further 120s so a session expiring right at the edge can't race
    // ahead of a still-live hold.
    const stripeExpiresAt = nowSec + config.holdMinutes * 60 + 60;
    const holdUntil = stripeExpiresAt + 120;
    const orderId = crypto.randomUUID();
    const inserted = await tryInsertHeldOrder(c.env.DB, {
      id: orderId, date: body.date, sizeId: size.id, fulfillment: body.fulfillment,
      customerName: body.customer.name, customerEmail: body.customer.email, customerPhone: phone,
      addressJson, note: body.note ?? null, bouquetCents: size.priceCents, deliveryCents, uberQuoteId,
    }, cap, nowSec, holdUntil);
    if (!inserted) return c.json({ error: "sold_out" }, 409);

    const lineItems = [
      { name: `${size.name} — ${body.fulfillment} ${humanDate(body.date)}`, amountCents: size.priceCents, quantity: 1 },
    ];
    if (deliveryCents > 0) lineItems.push({ name: `Delivery — ${humanDate(body.date)}`, amountCents: deliveryCents, quantity: 1 });

    let session;
    try {
      session = await payments.createCheckout({
        orderId, customerEmail: body.customer.email, lineItems,
        successUrl: `${c.env.SITE_URL}/thanks?order=${orderId}`,
        cancelUrl: `${c.env.SITE_URL}/#order`,
        expiresAt: stripeExpiresAt,
      });
    } catch (err) {
```

The rest of the handler (the two failure paths that cancel the order and return 503, and the final `c.json({ url })`) is unchanged.

Two things this deliberately does NOT do. It never re-quotes: the fee the customer agreed to is the fee they pay (D8), and a second Uber call at this moment could return a different number after they have already seen the total. And it never reads a fee out of the request body — only out of the signed token — so an edited request changes nothing.

- [ ] **Step 6: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/core/delivery.test.ts tests/routes/public.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green. The Plan 1 pickup tests must be untouched; if `"holds a slot, creates a session with correct line items"` fails on the line item name, that is the intended `pickup` interpolation and its expected string is already `"Bouquet — pickup Wed Sep 9"`.

- [ ] **Step 7: Commit**

```bash
git add src/core/delivery.ts src/routes/public.ts tests/core/delivery.test.ts tests/routes/public.test.ts
git commit -m "feat(checkout): delivery orders — signed fee locked on the order, address stored, Delivery line item"
```

---
### Task 7: Delivery in the messages — confirmation, calendar event, owner copy, and the courier tracking email

**Files:**
- Modify: `src/core/messages.ts`, `src/jobs/outbox.ts`, `tests/core/messages.test.ts`, `tests/jobs/outbox.test.ts`

**Interfaces:**
- Consumes: `Order` with `addressJson`, `deliveryCents` (Task 3); `Delivery` and `activeDeliveryFor` (Task 3); `PostalAddress` (Task 2).
- Produces (`src/core/messages.ts`): `deliveryAddressOf(order)`, `formatAddress(a)`, `courierEmail(order, cfg, trackingUrl)`; `customerEmail`, `orderEvent` and `ownerEmail` now render delivery orders.
- Produces (`src/jobs/outbox.ts`): the `"courier_email"` case in `deliver`, replacing the Task 3 placeholder throw.

This is where spec §6's promise lands — "his phone calendar lists today's orders with size, note, and pickup **or address**" — so the address has to reach the calendar description and Anthony's copy, not only the database.

- [ ] **Step 1: Write the failing message tests**

Add to `tests/core/messages.test.ts` (it already builds `Order` fixtures; add `uberQuoteId: null` to each existing one so they typecheck against Task 3's widened type):

```ts
import { courierEmail, deliveryAddressOf, formatAddress } from "../../src/core/messages";

const ADDRESS = { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534", notes: "porch, behind the planter" };

function deliveryOrder(over: Partial<Order> = {}): Order {
  return {
    id: "11111111-2222-3333-4444-555555555555", createdAt: 1, status: "paid", date: "2026-09-23",
    sizeId: "bouquet", fulfillment: "delivery", customerName: "Pat Smith", customerEmail: "pat@example.com",
    customerPhone: "+15185550100", addressJson: JSON.stringify(ADDRESS), note: "for a birthday",
    stripeSessionId: "cs_1", stripePaymentIntent: "pi_1", bouquetCents: 8500, deliveryCents: 1350,
    uberQuoteId: "dqt_1", source: "one_time", holdExpiresAt: null, calendarEventId: null, ...over,
  };
}

describe("formatAddress / deliveryAddressOf", () => {
  it("renders one readable line and skips an empty unit", () => {
    expect(formatAddress(ADDRESS)).toBe("5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(formatAddress({ ...ADDRESS, unit: "" })).toBe("5 Elm Street, Hudson, NY 12534");
  });
  it("reads the address off an order, and returns null for pickup or corrupt JSON", () => {
    expect(deliveryAddressOf(deliveryOrder())!.zip).toBe("12534");
    expect(deliveryAddressOf(deliveryOrder({ addressJson: null }))).toBeNull();
    expect(deliveryAddressOf(deliveryOrder({ addressJson: "{" }))).toBeNull();
    expect(deliveryAddressOf(deliveryOrder({ addressJson: '{"street":"a"}' }))).toBeNull();
  });
});

describe("customerEmail for a delivery order", () => {
  it("says where and when it is going, not where to collect it, and shows the delivery charge", () => {
    const m = customerEmail(deliveryOrder(), cfg);
    expect(m.subject).toBe("Your Bull and Bloom bouquet for Wed Sep 23");
    expect(m.text).toContain("Your Bouquet is booked for delivery on Wednesday, September 23.");
    expect(m.text).toContain("Delivering to: 5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(m.text).toContain("Where to leave it: porch, behind the planter");
    expect(m.text).toContain("  Bouquet: $85.00");
    expect(m.text).toContain("  Delivery: $13.50");
    expect(m.text).toContain("  Total: $98.50");
    expect(m.text).toContain("You will get a tracking link when the courier is on the way.");
    expect(m.text).not.toContain("Pickup:");
  });
  it("leaves the pickup wording exactly as Plan 2 wrote it", () => {
    const m = customerEmail(deliveryOrder({ fulfillment: "pickup", addressJson: null, deliveryCents: 0 }), cfg);
    expect(m.text).toContain(`Pickup: ${cfg.studio.pickupInstructions}`);
    expect(m.text).toContain(`Address: ${cfg.studio.pickupAddress}`);
    expect(m.text).not.toContain("Delivering to:");
    expect(m.text).not.toContain("Total:");
  });
});

describe("orderEvent and ownerEmail for a delivery order", () => {
  it("puts the address in the calendar description so Anthony's phone shows it (spec §6)", () => {
    const e = orderEvent(deliveryOrder(), cfg, "https://x.test");
    expect(e.summary).toBe("Bouquet · Pat Smith · delivery");
    expect(e.description).toContain("Bouquet ($85.00) · delivery");
    expect(e.description).toContain("5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(e.description).toContain("porch, behind the planter");
  });
  it("puts the address in Anthony's copy too", () => {
    expect(ownerEmail(deliveryOrder(), cfg, "https://x.test").text).toContain("5 Elm Street, Apt 2, Hudson, NY 12534");
  });
  it("adds nothing to a pickup order", () => {
    const e = orderEvent(deliveryOrder({ fulfillment: "pickup", addressJson: null, deliveryCents: 0 }), cfg, "https://x.test");
    expect(e.description).not.toContain("Elm Street");
  });
});

describe("courierEmail", () => {
  it("gives the customer the tracking link and the address it is heading to", () => {
    const m = courierEmail(deliveryOrder(), cfg, "https://direct.uber.com/track/del_7");
    expect(m.to).toBe("pat@example.com");
    expect(m.subject).toBe("Your Bull and Bloom bouquet is on the way");
    expect(m.text).toContain("Hi Pat,");
    expect(m.text).toContain("https://direct.uber.com/track/del_7");
    expect(m.text).toContain("5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(m.text).toContain("Anthony");
  });
  it("still sends when the address cannot be read, because the tracking link is the point", () => {
    const m = courierEmail(deliveryOrder({ addressJson: null }), cfg, "https://t.test/1");
    expect(m.text).toContain("https://t.test/1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/core/messages.test.ts`
Expected: FAIL — `courierEmail`, `formatAddress` and `deliveryAddressOf` do not exist.

- [ ] **Step 3: Implement the message changes**

In `src/core/messages.ts`, add the address helpers after `dollars`:

```ts
import type { PostalAddress } from "../config";

export interface DeliveryAddress extends PostalAddress { notes: string }

/** "5 Elm Street, Apt 2, Hudson, NY 12534" */
export function formatAddress(a: PostalAddress): string {
  return [a.street, a.unit, `${a.city}, ${a.state} ${a.zip}`].filter((p) => p && p.trim() !== "").join(", ");
}

/** The delivery address stored on an order, or null for pickup / anything unreadable. */
export function deliveryAddressOf(order: Order): DeliveryAddress | null {
  if (!order.addressJson) return null;
  try {
    const a = JSON.parse(order.addressJson) as Partial<DeliveryAddress>;
    if (!a || typeof a.street !== "string" || typeof a.city !== "string" || typeof a.state !== "string" || typeof a.zip !== "string") {
      return null;
    }
    return { street: a.street, unit: a.unit ?? "", city: a.city, state: a.state, zip: a.zip, notes: a.notes ?? "" };
  } catch {
    console.error(`messages: order ${order.id} has unreadable address_json`);
    return null;
  }
}
```

Replace `detailLines` so a delivery order carries its address into both the calendar description and Anthony's email:

```ts
/** Lines shared by the calendar description and Anthony's email: who, how to reach them, where, note, order link. */
function detailLines(order: Order, siteUrl: string): string[] {
  const lines = [order.customerName, contactLine(order)];
  const addr = deliveryAddressOf(order);
  if (addr) {
    lines.push(formatAddress(addr));
    if (addr.notes) lines.push(`Where to leave it: ${addr.notes}`);
  }
  if (order.note) lines.push(`Note: ${order.note}`);
  lines.push("", `Order ${shortId(order)} · paid online`, adminLink(order, siteUrl));
  return lines;
}
```

Replace `customerEmail` so a delivery order gets delivery wording and a priced total:

```ts
export function customerEmail(order: Order, cfg: StoreConfig): Mail {
  const size = sizeName(order, cfg);
  const firstName = order.customerName.trim().split(/\s+/)[0];
  const addr = deliveryAddressOf(order);
  const lines = [
    `Hi ${firstName},`,
    "",
    `Thank you. Your ${size} is booked for ${order.fulfillment} on ${longDate(order.date)}.`,
    "",
  ];
  if (order.fulfillment === "delivery") {
    if (addr) {
      lines.push(`Delivering to: ${formatAddress(addr)}`);
      if (addr.notes) lines.push(`Where to leave it: ${addr.notes}`);
    }
    lines.push("You will get a tracking link when the courier is on the way.");
  } else {
    lines.push(`Pickup: ${cfg.studio.pickupInstructions}`, `Address: ${cfg.studio.pickupAddress}`);
  }
  lines.push("", "What you ordered", `  ${size}: ${dollars(order.bouquetCents)}`);
  if (order.deliveryCents > 0) {
    lines.push(`  Delivery: ${dollars(order.deliveryCents)}`, `  Total: ${dollars(order.bouquetCents + order.deliveryCents)}`);
  }
  if (order.note) lines.push(`  Your note: ${order.note}`);
  lines.push("", "Questions or a change of plans? Just reply to this email.", "", "Anthony", "The Bull and Bloom", "thebullandbloom.com");
  return { to: order.customerEmail, subject: `Your Bull and Bloom bouquet for ${humanDate(order.date)}`, text: lines.join("\n") };
}
```

And add the courier email at the end of the file:

```ts
/** Sent when Anthony taps "Request courier" (spec §2 item 10). One job: the tracking link. */
export function courierEmail(order: Order, cfg: StoreConfig, trackingUrl: string): Mail {
  const firstName = order.customerName.trim().split(/\s+/)[0];
  const addr = deliveryAddressOf(order);
  const lines = [
    `Hi ${firstName},`,
    "",
    `Your ${sizeName(order, cfg)} is made and a courier is on the way with it.`,
    "",
    `Follow it here: ${trackingUrl}`,
  ];
  if (addr) lines.push("", `Delivering to: ${formatAddress(addr)}`);
  lines.push("", "Questions? Just reply to this email.", "", "Anthony", "The Bull and Bloom", "thebullandbloom.com");
  return { to: order.customerEmail, subject: "Your Bull and Bloom bouquet is on the way", text: lines.join("\n") };
}
```

`orderEvent` and `ownerEmail` need no edit: both already build on `detailLines`.

- [ ] **Step 4: Write the failing outbox-job test**

Add to `tests/jobs/outbox.test.ts`:

```ts
import { enqueueCourierEmailStatement } from "../../src/store/outbox";
import { insertDelivery, applyStatus } from "../../src/store/deliveries";

async function paidDeliveryOrder(id: string, session: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, note, bouquet_cents, delivery_cents, stripe_session_id)
     VALUES (?, 1, 'paid', '2026-09-23', 'bouquet', 'delivery', 'Pat Smith', 'pat@example.com', '+15185550100',
       '{"street":"5 Elm Street","unit":"","city":"Hudson","state":"NY","zip":"12534","notes":"porch"}', NULL, 8500, 1350, ?)`,
  ).bind(id, session).run();
}

describe("drainOutbox — courier email", () => {
  it("sends the tracking link for the order's live delivery", async () => {
    await saveState(env.DB, STATE);
    await paidDeliveryOrder("cd1", "cs_cd1");
    await insertDelivery(env.DB, {
      id: "del-row-1", orderId: "cd1", uberDeliveryId: "u_cd1", status: "pending",
      quotedCents: 1400, feeCents: 1400, trackingUrl: "https://direct.uber.com/track/u_cd1", at: NOW_SEC,
    });
    await env.DB.batch([enqueueCourierEmailStatement(env.DB, "cd1", NOW_SEC)]);
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 1, failed: 0 });
    expect(g.sent[0].to).toBe("pat@example.com");
    expect(g.sent[0].text).toContain("https://direct.uber.com/track/u_cd1");
  });

  it("drops the courier email when the delivery has since been canceled", async () => {
    await saveState(env.DB, STATE);
    await paidDeliveryOrder("cd2", "cs_cd2");
    await insertDelivery(env.DB, {
      id: "del-row-2", orderId: "cd2", uberDeliveryId: "u_cd2", status: "pending",
      quotedCents: 1400, feeCents: 1400, trackingUrl: "https://t.test/2", at: NOW_SEC,
    });
    await applyStatus(env.DB, "u_cd2", "canceled", "studio cancelled", NOW_SEC);
    await env.DB.batch([enqueueCourierEmailStatement(env.DB, "cd2", NOW_SEC)]);
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
    expect(g.sent).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
  });

  it("retries with backoff when Gmail is down, exactly like the other kinds", async () => {
    await saveState(env.DB, STATE);
    await paidDeliveryOrder("cd3", "cs_cd3");
    await insertDelivery(env.DB, {
      id: "del-row-3", orderId: "cd3", uberDeliveryId: "u_cd3", status: "pending",
      quotedCents: 1400, feeCents: 1400, trackingUrl: "https://t.test/3", at: NOW_SEC,
    });
    await env.DB.batch([enqueueCourierEmailStatement(env.DB, "cd3", NOW_SEC)]);
    const g = new FakeGoogle();
    g.failNext = "gmail down";
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 1 });
    const row = await env.DB.prepare("SELECT attempts, last_error FROM outbox WHERE order_id = 'cd3'").first<any>();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("gmail down");
  });
});
```

(These tests share the file's existing `beforeEach`, which clears the connection and the outbox; add `await env.DB.prepare("DELETE FROM deliveries").run();` to that `beforeEach` so a delivery row from one case cannot leak into the next.)

- [ ] **Step 5: Implement the outbox case**

In `src/jobs/outbox.ts`, replace the Task 3 placeholder and add the handler:

```ts
import { courierEmail, customerEmail, orderEvent, ownerEmail } from "../core/messages";
import { activeDeliveryFor } from "../store/deliveries";
```

```ts
  switch (item.kind) {
    case "calendar_event": await calendarEvent(deps, state, order); return true;
    case "email_customer": await deps.google.sendMail(customerEmail(order, deps.config)); return true;
    case "email_owner": await deps.google.sendMail(ownerEmail(order, deps.config, deps.siteUrl)); return true;
    case "courier_email": {
      // The tracking link belongs to a live courier job. If the job was canceled between the
      // dispatch and this drain, there is nothing worth telling the customer to follow.
      const delivery = await activeDeliveryFor(deps.db, order.id);
      if (!delivery) {
        console.error(`outbox: order ${order.id} has no live delivery; dropping courier_email`);
        return false;
      }
      await deps.google.sendMail(courierEmail(order, deps.config, delivery.trackingUrl));
      return true;
    }
  }
```

- [ ] **Step 6: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/core/messages.test.ts tests/jobs/outbox.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/core/messages.ts src/jobs/outbox.ts tests/core/messages.test.ts tests/jobs/outbox.test.ts
git commit -m "feat(messages): delivery address in confirmations and calendar events; courier tracking email"
```

---
### Task 8: Admin dispatch — "Request courier", delivery status, and the variance total

**Files:**
- Create: `src/routes/admin-delivery.ts`, `tests/routes/admin-delivery.test.ts`
- Modify: `src/routes/admin.ts`, `tests/routes/admin.test.ts`

**Interfaces:**
- Consumes: `Uber`, `UberError` (Task 1); `deliveryWindow`, `deliveryItemName`, `normalizePhone` (Tasks 5–6); `deliveryAddressOf` (Task 7); `insertDeliveryStatement`, `activeDeliveryFor`, `deliveriesForDate`, `varianceTotal` (Task 3); `enqueueCourierEmailStatement` (Task 3); `drainOutbox` (Plan 2); `background` (Plan 2).
- Produces: `registerDeliveryAdmin(r)` (`src/routes/admin-delivery.ts`), mounted by `adminRoutes()` exactly as `registerGoogleAdmin` is; `POST /admin/api/orders/:id/dispatch`; `GET /admin/api/delivery/status`; `GET /admin/api/orders` now returns `{ orders, deliveries }`.

- [ ] **Step 1: Write the failing tests**

`tests/routes/admin-delivery.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp } from "../helpers";
import { saveState, clearConnection } from "../../src/store/google";
import { insertDelivery, applyStatus } from "../../src/store/deliveries";

async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  expect(r.status).toBe(204);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" } });
}

const ADDRESS = '{"street":"5 Elm Street","unit":"Apt 2","city":"Hudson","state":"NY","zip":"12534","notes":"porch"}';

async function order(id: string, over: Partial<{ status: string; fulfillment: string; phone: string | null; address: string | null; deliveryCents: number }> = {}) {
  const o = { status: "paid", fulfillment: "delivery", phone: "+15185550100", address: ADDRESS, deliveryCents: 1200, ...over };
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, bouquet_cents, delivery_cents)
     VALUES (?, 1, ?, '2026-09-23', 'bouquet', ?, 'Pat Smith', 'pat@example.com', ?, ?, 8500, ?)`,
  ).bind(id, o.status, o.fulfillment, o.phone, o.address, o.deliveryCents).run();
}

describe("POST /admin/api/orders/:id/dispatch", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM orders").run();
    await clearConnection(env.DB);
  });

  it("refuses without a session", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/orders/x/dispatch", { method: "POST" })).status).toBe(401);
  });

  it("gets a fresh quote for right now, creates the delivery, stores it, and queues the tracking email", async () => {
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    await order("d1");
    const { fetch, uber, google } = testApp(new Date("2026-09-23T15:00:00Z"));
    uber.quoteFee = 1450;
    const as = await login(fetch);
    const r = await as("/admin/api/orders/d1/dispatch", { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.delivery).toMatchObject({ status: "pending", feeCents: 1450, trackingUrl: "https://track.uber.test/del_fake_2" });
    expect(body.variance).toEqual({ deliveries: 1, varianceCents: 250 });

    // the day-of quote asks for a pickup now, not at the studio's morning ready time
    expect(+uber.quoted[0].window.pickupReadyAt).toBe(+new Date("2026-09-23T15:00:00Z"));
    // the real customer phone and the real order value go on the delivery
    expect(uber.created[0].dropoff.phone).toBe("+15185550100");
    expect(uber.created[0].dropoff.notes).toBe("porch");
    expect(uber.created[0].dropoff.address.zip).toBe("12534");
    expect(uber.created[0].valueCents).toBe(8500);
    expect(uber.created[0].itemName).toBe("Bouquet — hand-tied flowers");
    expect(uber.created[0].quoteId).toBe("dqt_fake_1");
    expect(uber.created[0].idempotencyKey).toContain("d1");

    const row = await env.DB.prepare("SELECT order_id, uber_delivery_id, status, quoted_cents, fee_cents FROM deliveries").first<any>();
    expect(row).toEqual({ order_id: "d1", uber_delivery_id: "del_fake_2", status: "pending", quoted_cents: 1450, fee_cents: 1450 });

    // the tracking email went out on the same request (Google is connected)
    expect(google.sent.map((m) => m.subject)).toContain("Your Bull and Bloom bouquet is on the way");
  });

  it("queues the email but still succeeds when Google is not connected", async () => {
    await order("d2");
    const { fetch, google } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d2/dispatch", { method: "POST" })).status).toBe(200);
    expect(google.sent).toHaveLength(0);
    const box = await env.DB.prepare("SELECT kind, done_at FROM outbox WHERE order_id = 'd2'").first<any>();
    expect(box).toEqual({ kind: "courier_email", done_at: null });
  });

  it("refuses a pickup order, a non-paid order, and an unknown order", async () => {
    await order("d3", { fulfillment: "pickup", address: null });
    await order("d4", { status: "held" });
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d3/dispatch", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/d4/dispatch", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/nope/dispatch", { method: "POST" })).status).toBe(404);
  });

  it("refuses a second courier while one is live, and allows one after a cancellation", async () => {
    await order("d5");
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d5/dispatch", { method: "POST" })).status).toBe(200);
    const dup = await as("/admin/api/orders/d5/dispatch", { method: "POST" });
    expect(dup.status).toBe(409);
    expect((await dup.json() as any).error).toBe("courier_already_requested");
    await applyStatus(env.DB, "del_fake_2", "canceled", "courier cancelled", 5000);
    expect((await as("/admin/api/orders/d5/dispatch", { method: "POST" })).status).toBe(200);
  });

  it("leaves the order paid and reports the reason when Uber fails, so Anthony can retry or drive", async () => {
    await order("d6");
    const { fetch, uber } = testApp();
    const as = await login(fetch);
    uber.failWith("unavailable", "uber /deliveries 500: boom");
    const r = await as("/admin/api/orders/d6/dispatch", { method: "POST" });
    expect(r.status).toBe(502);
    expect((await r.json() as any).message).toContain("boom");
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'd6'").first<any>()).status).toBe("paid");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries").first<any>()).n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<any>()).n).toBe(0);
  });

  it("says so plainly when Uber is not set up on this deployment", async () => {
    await order("d7");
    const { fetch, uber } = testApp();
    uber.isConfigured = false;
    const as = await login(fetch);
    const r = await as("/admin/api/orders/d7/dispatch", { method: "POST" });
    expect(r.status).toBe(503);
    expect((await r.json() as any).error).toBe("uber_not_configured");
  });

  it("refuses an order whose address or phone the courier could not use", async () => {
    await order("d8", { address: null });
    await order("d9", { phone: null });
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d8/dispatch", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/d9/dispatch", { method: "POST" })).status).toBe(409);
  });
});

describe("GET /admin/api/delivery/status", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
  });

  it("reports whether Uber is set up, the fallback, and the running variance", async () => {
    await order("s1");
    await insertDelivery(env.DB, {
      id: "row1", orderId: "s1", uberDeliveryId: "u_s1", status: "delivered",
      quotedCents: 1500, feeCents: 1500, trackingUrl: "https://t.test/1", at: 10,
    });
    const { fetch } = testApp();
    const as = await login(fetch);
    const body = await (await as("/admin/api/delivery/status")).json() as any;
    expect(body.configured).toBe(true);
    expect(body.fallbackFeeCents).toBeGreaterThan(0);
    expect(Array.isArray(body.fallbackZips)).toBe(true);
    expect(body.variance).toEqual({ deliveries: 1, varianceCents: 300 });
  });
});

describe("GET /admin/api/orders with deliveries", () => {
  it("returns the delivery beside its order so the day panel can show a tracking link", async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
    await order("o1");
    await insertDelivery(env.DB, {
      id: "row2", orderId: "o1", uberDeliveryId: "u_o1", status: "dropoff",
      quotedCents: 1200, feeCents: 1200, trackingUrl: "https://t.test/2", at: 10,
    });
    const { fetch } = testApp();
    const as = await login(fetch);
    const body = await (await as("/admin/api/orders?date=2026-09-23")).json() as any;
    expect(body.orders.map((o: any) => o.id)).toContain("o1");
    expect(body.deliveries.o1).toMatchObject({ status: "dropoff", trackingUrl: "https://t.test/2", feeCents: 1200 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/routes/admin-delivery.test.ts`
Expected: FAIL — every dispatch call 404s (no such route).

- [ ] **Step 3: Implement the delivery admin routes**

`src/routes/admin-delivery.ts`:

```ts
import type { App } from "../app";
import { UberError } from "../adapters/uber";
import { deliveryItemName, deliveryWindow, normalizePhone } from "../core/delivery";
import { deliveryAddressOf } from "../core/messages";
import { activeDeliveryFor, insertDeliveryStatement, latestDeliveryFor, varianceTotal } from "../store/deliveries";
import { enqueueCourierEmailStatement } from "../store/outbox";
import { getOrder } from "../store/orders";
import { sizeById } from "../config";
import { drainOutbox } from "../jobs/outbox";
import { background } from "./background";

/** Mounted from adminRoutes() AFTER its cookie middleware, so every route here needs a session. */
export function registerDeliveryAdmin(r: App): void {
  r.get("/admin/api/delivery/status", async (c) => {
    const { uber, config } = c.get("services");
    return c.json({
      configured: uber.configured(),
      fallbackFeeCents: config.delivery.fallbackFeeCents,
      fallbackZips: config.delivery.fallbackZips,
      variance: await varianceTotal(c.env.DB),
    });
  });

  r.post("/admin/api/orders/:id/dispatch", async (c) => {
    const { uber, google, config, clock } = c.get("services");
    const order = await getOrder(c.env.DB, c.req.param("id"));
    if (!order) return c.json({ error: "not_found" }, 404);
    if (order.fulfillment !== "delivery") return c.json({ error: "not_a_delivery", message: "This is a pickup order." }, 409);
    if (order.status !== "paid") return c.json({ error: "not_paid", message: `Cannot request a courier for a ${order.status} order.` }, 409);
    if (await activeDeliveryFor(c.env.DB, order.id)) {
      return c.json({ error: "courier_already_requested", message: "A courier is already on this one." }, 409);
    }
    if (!uber.configured()) {
      return c.json({ error: "uber_not_configured", message: "Uber is not set up on this site yet — deliver this one yourself." }, 503);
    }

    const address = deliveryAddressOf(order);
    if (!address) return c.json({ error: "no_address", message: "This order has no usable delivery address." }, 409);
    const phone = normalizePhone(order.customerPhone);
    if (!phone) return c.json({ error: "no_phone", message: "This order has no phone number the courier can call." }, 409);

    const now = clock();
    const nowSec = Math.floor(now.getTime() / 1000);
    const pickup = {
      name: "The Bull and Bloom", phone: config.studio.phone, businessName: "The Bull and Bloom",
      address: config.studio.address, notes: config.studio.pickupInstructions,
    };
    const dropoff = { name: order.customerName, phone, address, notes: address.notes || undefined };
    // Day-of dispatch always re-quotes: the checkout quote is minutes-old at best (D8).
    const window = deliveryWindow(now, now);
    // Idempotency is keyed on the order and its previous attempt, not on the clock: two admin tabs
    // pressing the button together send Uber the same key, so it books ONE courier and returns it
    // to both; a genuine re-request after a canceled job has a new key because `latest` changed.
    const previous = await latestDeliveryFor(c.env.DB, order.id);
    const idempotencyKey = `${order.id}:${previous?.id ?? "first"}`;

    let delivery;
    let quotedCents: number;
    try {
      const quote = await uber.quote({ pickup, dropoff, window, valueCents: order.bouquetCents });
      quotedCents = quote.feeCents;
      delivery = await uber.createDelivery({
        quoteId: quote.id, pickup, dropoff, window, valueCents: order.bouquetCents,
        itemName: deliveryItemName(sizeById(config, order.sizeId)?.name ?? order.sizeId),
        reference: order.id.slice(0, 8),
        idempotencyKey,
      });
    } catch (err) {
      // Spec §4.5: the order stays paid; Anthony retries or delivers himself.
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof UberError ? err.code : "unavailable";
      console.error(`dispatch: order ${order.id} failed (${code})`, message);
      return c.json({ error: "dispatch_failed", code, message }, 502);
    }

    await c.env.DB.batch([
      insertDeliveryStatement(c.env.DB, {
        id: crypto.randomUUID(), orderId: order.id, uberDeliveryId: delivery.id,
        status: (delivery.status || "pending") as never,
        quotedCents, feeCents: delivery.feeCents, trackingUrl: delivery.trackingUrl, at: nowSec,
      }),
      enqueueCourierEmailStatement(c.env.DB, order.id, nowSec),
    ]);

    await background(c, drainOutbox({ db: c.env.DB, google, config, siteUrl: c.env.SITE_URL }, now));
    return c.json({ ok: true, delivery, variance: await varianceTotal(c.env.DB) });
  });
}
```

Three notes. `pickup.name` is the studio, not Anthony's personal name: the courier sees this in their app, and the studio name is what is on the door. The delivery row and the email enqueue go in one `db.batch`, the same guarantee D20 gives the paid-order kinds — a courier that exists always has its tracking email queued. And the idempotency key is `order id + previous delivery row id`, not the time: the admin button disables itself, but two tabs (or a retried request) must never book two couriers, and Uber's ~60-minute de-duplication on the key is what makes the second call return the first courier instead — the `INSERT OR IGNORE` in Task 3 then makes the second row a no-op.

- [ ] **Step 4: Mount it and widen the orders endpoint**

In `src/routes/admin.ts`:

```ts
import { registerGoogleAdmin } from "./admin-google";
import { registerDeliveryAdmin } from "./admin-delivery";
import { deliveriesForDate } from "../store/deliveries";
```

Replace the orders handler:

```ts
  r.get("/admin/api/orders", async (c) => {
    const date = c.req.query("date");
    if (!isYmd(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    const [orders, deliveries] = await Promise.all([listOrders(c.env.DB, date), deliveriesForDate(c.env.DB, date)]);
    return c.json({ orders, deliveries: Object.fromEntries(deliveries) });
  });
```

and register the new routes next to the Google ones:

```ts
  registerGoogleAdmin(r);
  registerDeliveryAdmin(r);

  return r;
```

`tests/routes/admin.test.ts` asserts `{ orders: [...] }` from that endpoint; the shape is now `{ orders, deliveries }`. Change those assertions from `toEqual` on the whole body to `toMatchObject({ orders: … })`, or read `body.orders` — whichever the existing test does more naturally. Nothing about `orders` itself changed.

- [ ] **Step 5: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/routes/admin-delivery.test.ts tests/routes/admin.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin-delivery.ts src/routes/admin.ts tests/routes/admin-delivery.test.ts tests/routes/admin.test.ts
git commit -m "feat(admin): request a courier — fresh quote, Uber delivery, tracking email, variance total"
```

---
### Task 9: `POST /webhooks/uber` — signed status updates, `delivered` closes the order

**Files:**
- Modify: `src/routes/webhooks.ts`, `src/store/orders.ts`, `tests/routes/webhooks.test.ts`, `tests/store/orders.test.ts`

**Interfaces:**
- Consumes: `verifyUberSignature` (Task 1); `applyStatus`, `DeliveryStatus` (Task 3).
- Produces: `POST /webhooks/uber`; `markDoneIfPaid(db, orderId)` in `src/store/orders.ts`.

Uber's own retry policy (verified 2026-09-09) is 10 s, then 30/60/120 s, three attempts, on any 5xx or timeout — so the handler must be idempotent and must answer 200 to anything it cannot act on, or Uber will hammer a request that will never succeed.

- [ ] **Step 1: Write the failing tests**

Add to `tests/routes/webhooks.test.ts`:

```ts
import { insertDelivery } from "../../src/store/deliveries";

/** Sign a body exactly as Uber does: HMAC-SHA256 of the raw body, lowercase hex. */
async function uberSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uberHook(fetch: any, payload: unknown, opts: { header?: string; signature?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = opts.signature ?? await uberSign("test-webhook-secret", body);
  const header = opts.header ?? "x-uber-signature";
  return fetch("/webhooks/uber", { method: "POST", headers: { [header]: sig, "content-type": "application/json" }, body });
}

async function deliveryOrder(id: string, uberId: string, status = "paid") {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, bouquet_cents, delivery_cents)
     VALUES (?, 1, ?, '2026-09-23', 'bouquet', 'delivery', 'Pat', 'pat@example.com', '+15185550100',
       '{"street":"5 Elm St","unit":"","city":"Hudson","state":"NY","zip":"12534","notes":""}', 8500, 1200)`,
  ).bind(id, status).run();
  await insertDelivery(env.DB, {
    id: `row_${uberId}`, orderId: id, uberDeliveryId: uberId, status: "pending",
    quotedCents: 1200, feeCents: 1250, trackingUrl: `https://t.test/${uberId}`, at: 100,
  });
}

const statusEvent = (deliveryId: string, status: string, extra: Record<string, unknown> = {}) => ({
  kind: "event.delivery_status", delivery_id: deliveryId, status,
  created: "2026-09-23T15:20:00Z", customer_id: "cus_test", live_mode: true,
  data: { id: deliveryId, status, ...extra },
});

describe("POST /webhooks/uber", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM deliveries").run();
    await env.DB.prepare("DELETE FROM orders").run();
  });

  it("moves the delivery through its statuses and is idempotent", async () => {
    await deliveryOrder("u1", "del_1");
    const { fetch } = testApp(new Date("2026-09-23T15:30:00Z"));
    for (const s of ["pickup", "pickup_complete", "dropoff"]) {
      const r = await uberHook(fetch, statusEvent("del_1", s));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ received: true, applied: s });
    }
    await uberHook(fetch, statusEvent("del_1", "dropoff"));
    const rows = await env.DB.prepare("SELECT status, updated_at FROM deliveries WHERE uber_delivery_id = 'del_1'").all<any>();
    expect(rows.results).toEqual([{ status: "dropoff", updated_at: Math.floor(new Date("2026-09-23T15:30:00Z").getTime() / 1000) }]);
  });

  it("marks the order done when the bouquet is delivered, once", async () => {
    await deliveryOrder("u2", "del_2");
    const { fetch } = testApp();
    expect(await (await uberHook(fetch, statusEvent("del_2", "delivered"))).json()).toEqual({ received: true, applied: "delivered" });
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u2'").first<any>()).status).toBe("done");
    // a replay must not resurrect anything or throw
    expect((await uberHook(fetch, statusEvent("del_2", "delivered"))).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u2'").first<any>()).status).toBe("done");
  });

  it("never un-cancels an order that was refunded before the courier finished", async () => {
    await deliveryOrder("u3", "del_3", "refunded");
    const { fetch } = testApp();
    await uberHook(fetch, statusEvent("del_3", "delivered"));
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u3'").first<any>()).status).toBe("refunded");
  });

  it("records the reason on a canceled or returned delivery so admin can show it", async () => {
    await deliveryOrder("u4", "del_4");
    const { fetch } = testApp();
    await uberHook(fetch, statusEvent("del_4", "returned", { undeliverable_reason: "customer_unavailable" }));
    const row = await env.DB.prepare("SELECT status, last_error FROM deliveries WHERE uber_delivery_id = 'del_4'").first<any>();
    expect(row).toEqual({ status: "returned", last_error: "customer_unavailable" });
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'u4'").first<any>()).status).toBe("paid");
  });

  it("accepts the legacy x-postmates-signature header", async () => {
    await deliveryOrder("u5", "del_5");
    const { fetch } = testApp();
    const r = await uberHook(fetch, statusEvent("del_5", "pickup"), { header: "x-postmates-signature" });
    expect(r.status).toBe(200);
  });

  it("rejects a wrong signature and a missing one", async () => {
    const { fetch } = testApp();
    expect((await uberHook(fetch, statusEvent("del_x", "pickup"), { signature: "deadbeef" })).status).toBe(400);
    const r = await fetch("/webhooks/uber", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
  });

  it("acknowledges a delivery it has never heard of, and other event kinds, without touching anything", async () => {
    const { fetch } = testApp();
    expect(await (await uberHook(fetch, statusEvent("del_unknown", "pickup"))).json()).toEqual({ received: true, applied: "unknown" });
    expect(await (await uberHook(fetch, { kind: "event.courier_update", delivery_id: "del_1", location: {} })).json())
      .toEqual({ received: true, applied: "ignored" });
    expect(await (await uberHook(fetch, { kind: "event.refund_request", delivery_id: "del_1" })).json())
      .toEqual({ received: true, applied: "ignored" });
  });

  it("ignores a status value it does not know rather than writing it", async () => {
    await deliveryOrder("u6", "del_6");
    const { fetch } = testApp();
    expect(await (await uberHook(fetch, statusEvent("del_6", "teleported"))).json()).toEqual({ received: true, applied: "ignored" });
    expect((await env.DB.prepare("SELECT status FROM deliveries WHERE uber_delivery_id = 'del_6'").first<any>()).status).toBe("pending");
  });
});
```

Add to `tests/store/orders.test.ts`:

```ts
  it("marks an order done only from paid", async () => {
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents)
       VALUES ('md1', 1, 'paid', '2026-10-07', 'bouquet', 'delivery', 'A', 'a@example.com', 8500),
              ('md2', 1, 'refunded', '2026-10-07', 'bouquet', 'delivery', 'B', 'b@example.com', 8500)`,
    ).run();
    expect(await markDoneIfPaid(env.DB, "md1")).toBe(true);
    expect(await markDoneIfPaid(env.DB, "md1")).toBe(false);
    expect(await markDoneIfPaid(env.DB, "md2")).toBe(false);
    expect((await getOrder(env.DB, "md2"))!.status).toBe("refunded");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/routes/webhooks.test.ts tests/store/orders.test.ts`
Expected: FAIL — `/webhooks/uber` 404s and `markDoneIfPaid` is not exported.

- [ ] **Step 3: Add the guarded status change**

Append to `src/store/orders.ts`:

```ts
/** `delivered` from Uber closes a paid order. Guarded so a replay, or a refund that beat the
 *  courier's last event, is never overwritten. */
export async function markDoneIfPaid(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("UPDATE orders SET status = 'done' WHERE id = ? AND status = 'paid'").bind(id).run();
  return res.meta.changes === 1;
}
```

- [ ] **Step 4: Implement the webhook**

`src/routes/webhooks.ts` — add the imports and the route inside `webhookRoutes()` after the Stripe one:

```ts
import { verifyUberSignature } from "../adapters/uber";
import { applyStatus, type DeliveryStatus } from "../store/deliveries";
import { markDoneIfPaid } from "../store/orders";
```

```ts
const DELIVERY_STATUSES: readonly DeliveryStatus[] =
  ["pending", "pickup", "pickup_complete", "dropoff", "delivered", "canceled", "returned"];

/** Only statuses we model; anything else (a new Uber value, a typo) is acknowledged and dropped. */
function knownStatus(v: unknown): DeliveryStatus | null {
  return typeof v === "string" && (DELIVERY_STATUSES as readonly string[]).includes(v) ? (v as DeliveryStatus) : null;
}
```

```ts
  r.post("/webhooks/uber", async (c) => {
    const { clock } = c.get("services");
    const secret = c.env.UBER_WEBHOOK_SECRET;
    const raw = await c.req.text();
    // Both headers are accepted: `x-uber-signature` is current, `x-postmates-signature` is the
    // legacy alias Uber still sends on delivery-status events (verified 2026-09-09).
    const sig = c.req.header("x-uber-signature") ?? c.req.header("x-postmates-signature");
    if (!secret || !(await verifyUberSignature(secret ?? "", raw, sig))) {
      console.error("webhook: bad uber signature");
      return c.json({ error: "bad signature" }, 400);
    }

    let event: any;
    try { event = JSON.parse(raw); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (event?.kind !== "event.delivery_status") return c.json({ received: true, applied: "ignored" });

    const deliveryId = typeof event.delivery_id === "string" ? event.delivery_id
      : typeof event?.data?.id === "string" ? event.data.id : "";
    const status = knownStatus(event.status ?? event?.data?.status);
    if (!deliveryId || !status) return c.json({ received: true, applied: "ignored" });

    const nowSec = Math.floor(clock().getTime() / 1000);
    const reason = typeof event?.data?.undeliverable_reason === "string" ? event.data.undeliverable_reason : null;
    const delivery = await applyStatus(c.env.DB, deliveryId, status, reason, nowSec);
    if (!delivery) {
      // A delivery from another environment, or one whose row we lost. Acknowledge so Uber stops retrying.
      console.error("webhook: uber status for a delivery we do not have", deliveryId, status);
      return c.json({ received: true, applied: "unknown" });
    }
    if (status === "delivered") await markDoneIfPaid(c.env.DB, delivery.orderId);
    return c.json({ received: true, applied: status });
  });
```

A missing `UBER_WEBHOOK_SECRET` answers 400, not 503: a deployment with no secret cannot tell a real Uber call from a forged one, and 400 is the same answer a forgery gets. It is logged either way.

- [ ] **Step 5: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/routes/webhooks.test.ts tests/store/orders.test.ts` → PASS
Run: `npm test && npm run typecheck` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/webhooks.ts src/store/orders.ts tests/routes/webhooks.test.ts tests/store/orders.test.ts
git commit -m "feat(webhooks): Uber delivery-status webhook — signature check, status updates, delivered closes the order"
```

---
### Task 10: Storefront order flow — pickup or delivery, address, live quote

**Files:**
- Modify: `site/index.html`, `site/store.js`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: `POST /api/quote` and the widened `POST /api/checkout` (Tasks 5–6), and `GET /api/config`'s new `delivery.offered` flag (Task 5).
- Produces: nothing other code imports. Plan 1's convention holds — the static page has no unit-test harness; `tests/smoke.test.ts` asserts only that the markup exists, and Step 5 is a by-hand check.

Keep the ES5 style of the existing file: `var`, no arrow functions, no template literals, no `const`/`let`, no `fetch` body helpers beyond what is already used.

- [ ] **Step 1: Markup for the fulfillment choice and address**

In `site/index.html`, inside `<form class="form" id="order-form" novalidate>`, replace the block from the day fieldset through the phone label with:

```html
      <fieldset class="full sizes" id="size-picker"><legend>Size</legend></fieldset>
      <fieldset class="full days" id="day-picker"><legend>Day</legend><p class="form-note" id="day-note"></p></fieldset>
      <fieldset class="full sizes" id="fulfillment-picker" hidden>
        <legend>Pickup or delivery</legend>
        <label><input type="radio" name="fulfillment" value="pickup" checked><span>Pickup — free</span></label>
        <label><input type="radio" name="fulfillment" value="delivery"><span>Delivery</span></label>
      </fieldset>
      <div class="full" id="delivery-fields" hidden>
        <div class="form" style="max-width:none">
          <label class="full">Street address<input type="text" name="street" autocomplete="address-line1"></label>
          <label>Apartment or unit <span class="opt">(optional)</span><input type="text" name="unit" autocomplete="address-line2"></label>
          <label>City<input type="text" name="city" autocomplete="address-level2"></label>
          <label>State<input type="text" name="state" maxlength="2" size="2" autocomplete="address-level1" placeholder="NY"></label>
          <label>ZIP<input type="text" name="zip" inputmode="numeric" maxlength="5" autocomplete="postal-code"></label>
          <label class="full">Where should we leave it? <span class="opt">(buzzer code, porch, front desk)</span><input type="text" name="deliveryNotes" maxlength="280"></label>
        </div>
        <p class="form-note" id="quote-note" role="status" aria-live="polite"></p>
      </div>
      <label>Name<input type="text" name="name" required autocomplete="name"></label>
      <label>Email<input type="email" name="email" required autocomplete="email"></label>
      <label>Phone <span class="opt" id="phone-hint">(optional)</span><input type="tel" name="phone" autocomplete="tel"></label>
```

And replace the submit row at the end of the form with one that carries a running total:

```html
      <div class="full"><button class="btn" type="submit" id="pay-btn" disabled>Continue to payment</button><p class="form-note" id="order-total"></p><p class="form-status" role="status" aria-live="polite" id="order-status"></p></div>
```

Update the section's intro sentence (currently "…Pickup is free.") to mention delivery:

```html
    <p class="intro">Every bouquet is built from whatever is best that morning. Pick a size, pick a day, and Anthony does the rest. Pickup is free; delivery is priced by address when you enter it.</p>
```

- [ ] **Step 2: Storefront script — state, reveal, and the quote**

Replace the whole of `site/store.js` with:

```js
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var menu = $('#menu'), sizes = $('#size-picker'), days = $('#day-picker'), dayNote = $('#day-note');
  var form = $('#order-form'), pay = $('#pay-btn'), status = $('#order-status');
  var fulfil = $('#fulfillment-picker'), deliveryFields = $('#delivery-fields');
  var quoteNote = $('#quote-note'), phoneHint = $('#phone-hint'), totalLine = $('#order-total');
  if (!form) return;

  // The last accepted quote: token is what checkout trusts (the fee is signed into it, so the
  // browser cannot change the price). Cleared whenever the address or day changes.
  var quote = null;      // { feeCents: number, token: string, kind: 'uber'|'fallback' }
  var quoteSeq = 0;      // guards against a slow response overwriting a newer one
  var quoteTimer = null;
  var deliveryOffered = false;
  var priceBySize = {};

  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function human(s) {
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function val(name) { var el = form.elements[name]; return el && el.value ? el.value.trim() : ''; }
  function isDelivery() { return form.elements['fulfillment'] && form.elements['fulfillment'].value === 'delivery'; }

  function renderSizes(cfg) {
    menu.innerHTML = '';
    sizes.querySelectorAll('label').forEach(function (l) { l.remove(); });
    priceBySize = {};
    cfg.sizes.forEach(function (s, i) {
      priceBySize[s.id] = s.priceCents;
      var li = document.createElement('li');
      li.innerHTML = '<h3></h3><p></p><p class="price"></p>';
      li.querySelector('h3').textContent = s.name;
      li.querySelector('p').textContent = s.description;
      li.querySelector('.price').textContent = money(s.priceCents);
      menu.appendChild(li);
      var lab = document.createElement('label');
      lab.innerHTML = '<input type="radio" name="sizeId"><span></span>';
      lab.querySelector('input').value = s.id;
      lab.querySelector('input').checked = i === 0;
      lab.querySelector('span').textContent = s.name + ' · ' + money(s.priceCents);
      sizes.appendChild(lab);
    });
    deliveryOffered = !!(cfg.delivery && cfg.delivery.offered);
    fulfil.hidden = !deliveryOffered;
    applyFulfillment();
  }

  function renderDays(av) {
    days.querySelectorAll('label').forEach(function (l) { l.remove(); });
    var any = false;
    av.days.forEach(function (d) {
      if (!d.open) return;
      var lab = document.createElement('label');
      lab.innerHTML = '<input type="radio" name="date"><span></span>';
      var inp = lab.querySelector('input');
      inp.value = d.date;
      inp.disabled = !d.orderable;
      if (!d.orderable) lab.className = 'sold';
      lab.querySelector('span').textContent = human(d.date) + (d.orderable && d.remaining <= 2 ? ' · ' + d.remaining + ' left' : '');
      days.insertBefore(lab, dayNote);
      any = any || d.orderable;
    });
    dayNote.textContent = any ? 'Same-day orders close at the morning cutoff.' : 'Nothing open in the next few weeks. Email Anthony and he will find a day.';
    refreshTotal();
  }

  /** Show or hide the address block and make the phone required for delivery (Uber needs it). */
  function applyFulfillment() {
    var d = isDelivery();
    deliveryFields.hidden = !d;
    form.elements['phone'].required = d;
    phoneHint.textContent = d ? '(the courier may call)' : '(optional)';
    ['street', 'city', 'state', 'zip'].forEach(function (n) { form.elements[n].required = d; });
    if (!d) { quote = null; quoteNote.textContent = ''; }
    refreshTotal();
  }

  function addressComplete() {
    return val('street') !== '' && val('city') !== '' && /^[A-Za-z]{2}$/.test(val('state')) && /^\d{5}$/.test(val('zip'));
  }

  function bouquetCents() {
    var el = form.querySelector('input[name="sizeId"]:checked');
    return el ? (priceBySize[el.value] || 0) : 0;
  }

  function refreshTotal() {
    var b = bouquetCents();
    var dayChosen = !!(new FormData(form)).get('date');
    if (!b || !dayChosen) { totalLine.textContent = ''; pay.disabled = true; return; }
    if (isDelivery()) {
      if (!quote) { totalLine.textContent = ''; pay.disabled = true; return; }
      totalLine.textContent = 'Bouquet ' + money(b) + ' + delivery ' + money(quote.feeCents) + ' = ' + money(b + quote.feeCents);
      pay.disabled = false;
      return;
    }
    totalLine.textContent = 'Total ' + money(b) + ' · pickup is free';
    pay.disabled = false;
  }

  function askForQuote() {
    if (!isDelivery()) return;
    var date = (new FormData(form)).get('date');
    quote = null;
    refreshTotal();
    if (!date) { quoteNote.textContent = 'Pick a day and we will price the delivery.'; return; }
    if (!addressComplete()) { quoteNote.textContent = 'Fill in the address and we will price the delivery.'; return; }
    quoteNote.textContent = 'Checking delivery…';
    var seq = ++quoteSeq;
    fetch('/api/quote', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        date: date,
        address: { street: val('street'), unit: val('unit'), city: val('city'), state: val('state').toUpperCase(), zip: val('zip') }
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (seq !== quoteSeq) return;                  // a newer request is in flight
        if (r.ok && r.body.available) {
          quote = { feeCents: r.body.feeCents, token: r.body.quoteToken, kind: r.body.kind };
          quoteNote.textContent = 'Delivery ' + money(r.body.feeCents) +
            (r.body.kind === 'fallback' ? ' — Anthony delivers this one himself.' : '');
        } else {
          quote = null;
          quoteNote.textContent = r.ok && r.body.reason === 'outside_area'
            ? 'That address is outside our delivery area. Choose pickup, or email Anthony.'
            : 'We could not price a delivery just now. Choose pickup, or try again in a minute.';
        }
        refreshTotal();
      })
      .catch(function () {
        if (seq !== quoteSeq) return;
        quote = null;
        quoteNote.textContent = 'We could not price a delivery just now. Choose pickup, or try again in a minute.';
        refreshTotal();
      });
  }

  function scheduleQuote() {
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = setTimeout(askForQuote, 400);
  }

  form.addEventListener('change', function (e) {
    var n = e.target.name;
    if (n === 'fulfillment') { applyFulfillment(); askForQuote(); return; }
    if (n === 'sizeId' || n === 'date') { refreshTotal(); if (n === 'date') askForQuote(); return; }
    if (n === 'street' || n === 'unit' || n === 'city' || n === 'state' || n === 'zip') scheduleQuote();
  });
  form.addEventListener('input', function (e) {
    var n = e.target.name;
    if (n === 'street' || n === 'city' || n === 'state' || n === 'zip') scheduleQuote();
  });

  function load() {
    var today = new Date(), to = new Date(today.getTime() + 27 * 86400000);
    return Promise.all([
      fetch('/api/config').then(function (r) { return r.json(); }),
      fetch('/api/availability?from=' + ymd(today) + '&to=' + ymd(to)).then(function (r) { return r.json(); })
    ]).then(function (res) { renderSizes(res[0]); renderDays(res[1]); })
      .catch(function () { status.textContent = 'The store is briefly unavailable. Email thebullandbloom@gmail.com to order.'; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(form);
    if (!f.get('date')) { status.textContent = 'Pick a day.'; return; }
    if (isDelivery() && !quote) { status.textContent = 'We still need a delivery price for that address.'; return; }
    if (!form.reportValidity()) return;
    pay.disabled = true; status.textContent = 'One moment…';
    var body = {
      sizeId: f.get('sizeId'), date: f.get('date'), fulfillment: isDelivery() ? 'delivery' : 'pickup',
      customer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
      note: f.get('note') || undefined
    };
    if (isDelivery()) {
      body.delivery = {
        address: { street: val('street'), unit: val('unit'), city: val('city'), state: val('state').toUpperCase(), zip: val('zip') },
        notes: val('deliveryNotes') || undefined,
        quoteToken: quote.token
      };
    }
    fetch('/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.ok) { window.location.href = r.body.url; return; }
        pay.disabled = false;
        if (r.status === 409) { status.textContent = 'That day just filled up. Pick another.'; load(); }
        else if (r.status === 503) { status.textContent = 'Payments are briefly unavailable. Try again in a minute.'; }
        else if (r.body.error === 'quote_expired') { status.textContent = 'That delivery price has expired. We are getting a fresh one.'; quote = null; askForQuote(); }
        else { status.textContent = r.body.error || 'Something went wrong.'; }
      })
      .catch(function () { pay.disabled = false; status.textContent = 'Something went wrong. Try again.'; });
  });

  load();
})();
```

Two behaviours worth naming, because they are easy to break on a later edit. `quoteSeq` means a slow answer for an old address can never install itself over a newer one — without it, typing a second address and getting the first reply last would charge the wrong fee. And `pay.disabled` is now owned entirely by `refreshTotal()`; the old code disabled it inside `renderDays`, which would have fought the delivery gate.

- [ ] **Step 3: Keep the smoke test honest about the new markup**

Add to `tests/smoke.test.ts`, inside the existing `describe("worker", …)`:

```ts
  it("serves the order form with a pickup/delivery choice and address fields", async () => {
    const r = await SELF.fetch("https://example.com/");
    const body = await r.text();
    expect(body).toContain('id="fulfillment-picker"');
    expect(body).toContain('id="delivery-fields"');
    expect(body).toContain('name="zip"');
    expect(body).toContain('id="quote-note"');
  });
```

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck` → all green.

- [ ] **Step 5: Verify by hand**

Run `npm run dev` (with the four Plan 1 secrets in `.dev.vars`; the Uber secrets may be absent). Open `http://localhost:8787/`:

1. With no Uber secrets and the sample `delivery.fallbackZips`, the pickup/delivery choice is visible (a fallback list is configured). Choose Delivery: the address fields appear, the phone hint becomes "(the courier may call)", and the pay button stays disabled until a day and a full address are in.
2. Enter a fallback zip (`12534`) with any street/city/state: the note reads "Delivery $15.00 — Anthony delivers this one himself." and the total line reads "Bouquet $85 + delivery $15 = $100".
3. Change the zip to one outside the list (`10001`): the note becomes "That address is outside our delivery area…" and the pay button disables again.
4. Switch back to Pickup: the address block hides, the total reads "Total $85 · pickup is free", the pay button re-enables.
5. Empty `delivery.fallbackZips` in `store.config.json` temporarily and restart: with no Uber secrets the whole pickup/delivery choice disappears and the page behaves exactly as Plan 1's did. Put the list back.

- [ ] **Step 6: Commit**

```bash
git add site/index.html site/store.js tests/smoke.test.ts
git commit -m "feat(store): pickup or delivery on the order form, address entry, live delivery quote"
```

---
### Task 11: Admin page — the address, "Request courier", the tracking line, and the variance total

**Files:**
- Modify: `site/admin/index.html`

**Interfaces:**
- Consumes: `GET /admin/api/orders` returning `{ orders, deliveries }`, `POST /admin/api/orders/:id/dispatch`, `GET /admin/api/delivery/status` (Task 8).
- Produces: nothing other code imports. Same Plan 1 convention as Task 10: no unit-test harness for the static page; Step 4 is a by-hand check.

Keep the file's ES5 style: `var`, `function`, no template literals, `textContent` rather than `innerHTML` for anything a customer typed.

- [ ] **Step 1: Markup**

In the toolbar `div.row`, add a Delivery button between Google and Sign out:

```html
      <button id="settings-btn">Settings</button><button id="google-btn">Google</button><button id="delivery-btn">Delivery</button><button id="logout">Sign out</button>
```

After the Google panel, add:

```html
    <div class="panel" id="delivery-panel" hidden>
      <h2 style="margin:0 0 .5rem;font-size:1.1rem;font-weight:500">Delivery</h2>
      <p id="d-summary" class="status"></p>
      <p id="d-variance" class="status"></p>
      <p class="status">Tap “Request courier” on a paid delivery order once the bouquet is made. The customer gets a tracking link straight away. Whatever the courier ends up costing, the customer pays what they were quoted — the difference is the number above.</p>
    </div>
```

Add two small styles inside the existing `<style>` block so the new lines read as secondary:

```css
  .order .addr{color:var(--sepia);font-size:.9rem}
  .order .track{font-size:.9rem}
  .order .err{color:#8B3A3A;font-size:.9rem}
```

- [ ] **Step 2: Show delivery on each order and add the button**

Replace `loadDay` with the version below. It keeps every Plan 1/2 behaviour and adds the address line, the delivery state, and the courier button.

```js
  function loadDay() {
    var d = cache[selected]; if (!d) return;
    $('#day-panel').hidden = false; $('#settings-panel').hidden = true; $('#google-panel').hidden = true; $('#delivery-panel').hidden = true;
    $('#day-title').textContent = new Date(selected + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    $('#day-cap').value = d.overrideCap === null ? '' : d.overrideCap;
    $('#day-cap').placeholder = 'default';
    $('#day-toggle').textContent = d.closed ? 'Reopen this day' : 'Close this day';
    api('/orders?date=' + selected).then(function (res) {
      var box = $('#orders'); box.innerHTML = '';
      var deliveries = res.deliveries || {};
      if (!res.orders.length) { box.innerHTML = '<p class="status">No orders.</p>'; return; }
      res.orders.forEach(function (o) {
        if (o.status === 'cancelled') return;
        var el = document.createElement('div'); el.className = 'order';
        el.innerHTML = '<div><strong></strong> · <span class="size"></span> · <span class="st"></span></div>' +
          '<small class="contact"></small><div class="addr"></div><div class="note"></div>' +
          '<div class="track"></div><div class="err"></div><div class="row"></div>';
        el.querySelector('strong').textContent = o.customerName;
        el.querySelector('.size').textContent = o.sizeId + (o.source === 'subscription' ? ' (subscription)' : '');
        el.querySelector('.st').textContent = o.status + ' · ' + o.fulfillment;
        el.querySelector('.contact').textContent = o.customerEmail + (o.customerPhone ? ' · ' + o.customerPhone : '');
        el.querySelector('.addr').textContent = addressLine(o);
        el.querySelector('.note').textContent = o.note || '';

        var del = deliveries[o.id];
        var track = el.querySelector('.track');
        if (del) {
          track.textContent = 'Courier: ' + del.status + ' · ' + money(del.feeCents) +
            (del.feeCents !== o.deliveryCents ? ' (customer paid ' + money(o.deliveryCents) + ')' : '');
          var a = document.createElement('a');
          a.href = del.trackingUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' track';
          track.appendChild(a);
          if (del.lastError) el.querySelector('.err').textContent = del.lastError;
        }

        var row = el.querySelector('.row');
        if (o.status === 'paid' || o.status === 'done') {
          var b = document.createElement('button');
          b.textContent = o.status === 'paid' ? 'Mark done' : 'Undo done';
          b.addEventListener('click', function () { api('/orders/' + o.id + (o.status === 'paid' ? '/done' : '/undone'), { method: 'POST' }).then(loadDay); });
          row.appendChild(b);
        }
        // Live courier jobs block a second request; canceled and returned ones do not.
        var live = del && del.status !== 'canceled' && del.status !== 'returned';
        if (o.fulfillment === 'delivery' && o.status === 'paid' && !live) {
          var c = document.createElement('button');
          c.textContent = del ? 'Request another courier' : 'Request courier';
          var msg = document.createElement('span'); msg.className = 'status';
          c.addEventListener('click', function () {
            c.disabled = true; msg.textContent = 'Asking Uber…';
            api('/orders/' + o.id + '/dispatch', { method: 'POST' })
              .then(function () { return loadDay(); })
              .catch(function (e) {
                if (e.message === 'unauthorized') return;
                c.disabled = false;
                msg.textContent = e.message + ' — try again, or deliver this one yourself.';
              });
          });
          row.appendChild(c); row.appendChild(msg);
        }
        box.appendChild(el);
      });
    });
  }
```

Add the two helpers next to `ymd`, before `loadMonth`:

```js
  function money(c) { return '$' + (c / 100).toFixed(2); }
  function addressLine(o) {
    if (o.fulfillment !== 'delivery' || !o.addressJson) return '';
    var a; try { a = JSON.parse(o.addressJson); } catch (e) { return 'address unreadable'; }
    var parts = [a.street, a.unit, a.city + ', ' + a.state + ' ' + a.zip].filter(function (p) { return p && p !== ''; });
    return parts.join(', ') + (a.notes ? ' — ' + a.notes : '');
  }
```

The dispatch error message comes straight from the API's `message` field, which `api()` already surfaces as `e.message`. That is deliberate: spec §4.5 says admin shows the error, and Anthony's next move ("deliver this one yourself") is in the sentence.

- [ ] **Step 3: The Delivery panel**

After `loadGoogle`'s handlers, add:

```js
  function loadDelivery() {
    $('#delivery-panel').hidden = false; $('#day-panel').hidden = true; $('#settings-panel').hidden = true; $('#google-panel').hidden = true;
    return api('/delivery/status').then(function (s) {
      $('#d-summary').textContent = s.configured
        ? 'Uber is set up. Addresses outside its range fall back to ' + money(s.fallbackFeeCents) + ' for ZIPs ' + (s.fallbackZips.join(', ') || '(none set)') + ', which you deliver yourself.'
        : 'Uber is not set up yet. Delivery is offered only for ZIPs ' + (s.fallbackZips.join(', ') || '(none set)') + ' at ' + money(s.fallbackFeeCents) + ', and you deliver those yourself.';
      var v = s.variance.varianceCents;
      $('#d-variance').textContent = s.variance.deliveries === 0
        ? 'No couriers requested yet.'
        : s.variance.deliveries + ' courier job(s) so far. ' + (v === 0
          ? 'Delivery has cost you exactly what customers paid.'
          : v > 0 ? 'They have cost you ' + money(v) + ' more than customers paid.'
                  : 'They have cost you ' + money(-v) + ' less than customers paid.');
    }).catch(function (e) {
      if (e.message === 'unauthorized') return;
      $('#d-summary').textContent = 'Could not load the delivery status: ' + e.message;
    });
  }
  $('#delivery-btn').addEventListener('click', loadDelivery);
```

and add `$('#delivery-panel').hidden = true;` to `loadSettings` and `loadGoogle` beside their existing panel toggles, so only one panel is ever open.

- [ ] **Step 4: Verify by hand**

Run `npm run dev` with the four Plan 1 secrets. Sign in to `http://localhost:8787/admin/`.

1. Press **Delivery**: with no Uber secrets the panel says Uber is not set up, names the fallback ZIPs and fee, and reports no couriers yet.
2. Buy a delivery bouquet on the storefront with a fallback ZIP, pay with `4242 4242 4242 4242`, then open that day in admin. The order shows `paid · delivery`, the address line, the instructions after an em dash, and a **Request courier** button.
3. Press **Request courier**: with no Uber secrets it fails in place with "Uber is not set up on this site yet — deliver this one yourself." and the order stays `paid`. That is the self-delivery case working as designed.
4. A pickup order on the same day has no address line and no courier button.

The happy path — a courier that is really created, tracked and delivered — is Task 12 Step 5 against Uber's sandbox.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test && npm run typecheck` → all green (the page is served by the smoke test's asset fetch; nothing else asserts on it).

```bash
git add site/admin/index.html
git commit -m "feat(admin): delivery address, Request courier, tracking line, and the fee variance panel"
```

---
### Task 12: Uber Direct account, secrets, webhook registration, and Robocourier acceptance

**Files:**
- Create: `scripts/uber-setup.sh`
- Modify: `README.md`, `docs/superpowers/specs/2026-09-07-store-design.md` (§3 D26–D32, §4.3, §7, §8, §9)

This task is console clicks, credentialed commands, and a walk-through with real Uber sandbox calls. It stays in the main session with Ryan (MeOS convention) — no subagent. Credentialed commands run through Ryan's terminal. Nothing here touches DNS or production billing.

**The account question, stated plainly before anything is clicked.** Uber Direct gives sandbox credentials on signup, but production needs billing on file and Uber's approval of the business — which is Anthony's business, not Ryan's. So: **Ryan opens a sandbox organisation under his own account now** so the whole flow can be built and accepted this week, and Anthony's production organisation is applied for in parallel. Moving to production is then a swap of four Cloudflare secrets and dropping `UBER_ROBOCOURIER` — no code change. If Uber declines Anthony's region entirely (spec §7 item 1), Plan 3 still ships: the fallback flat-fee path is a complete delivery product on its own, and Anthony drives.

- [x] **Step 1: Resolve the pending decisions**

Ryan answers the items under "Decisions Ryan made (pending)" at the top of this plan — the studio's real street address, a phone the courier can call, the daily ready time, the fallback ZIP list and flat fee, and whether the courier leaves the bouquet or hands it over. Each answer is a `store.config.json` edit (Task 2's shape) plus, for the hand-over choice, one line in `src/adapters/uber-api.ts` (`deliverable_action`). Make those edits and re-run `npm test` before continuing; SAMPLE values must not reach a real courier.

- [x] **Step 2: Uber Direct account and credentials (one time, ~20 minutes)**

At https://direct.uber.com, signed in as the account chosen in Step 1:

1. Create the organisation. Business name "The Bull and Bloom", the studio address from Step 1.
2. **Developer → Credentials**: copy the **Customer ID**, **Client ID** and **Client Secret** for the **test** environment. (Verified 2026-09-09: sandbox is not a separate host — the same `api.uber.com` with test-mode credentials, and Robocourier is switched on per request.)
3. **Developer → Webhooks**: add an endpoint `https://thebullandbloom.thebullandbloom.workers.dev/webhooks/uber`, subscribed to the delivery-status event. Copy the **Webhook Signing Key**. Add the production URL `https://thebullandbloom.com/webhooks/uber` now as well if the dashboard allows two, so cutover needs no console visit.
4. Append to `.dev.vars` (gitignored; never paste these into chat):

```
UBER_CLIENT_ID=…
UBER_CLIENT_SECRET=…
UBER_CUSTOMER_ID=…
UBER_WEBHOOK_SECRET=…
```

5. Apply for the **production** organisation in Anthony's name — business details, billing, the studio address. Approval is Uber's, not ours; record the date applied in the spec's §8 so a stalled application is visible.

- [x] **Step 3: Write and run the setup script**

`scripts/uber-setup.sh`:

```bash
#!/usr/bin/env bash
# One-shot Uber Direct wiring for the deployed Worker (Plan 3 Task 12). Reads the four Uber values
# from .dev.vars, uploads them as Cloudflare secrets, applies the delivery migration remotely, and
# redeploys the preview with Robocourier on so sandbox deliveries drive themselves.
# Usage: scripts/uber-setup.sh [preview-url]
set -euo pipefail
cd "$(dirname "$0")/.."

PREVIEW="${1:-https://thebullandbloom.thebullandbloom.workers.dev}"

[ -f .dev.vars ] || { echo "no .dev.vars — add the four UBER_* values" >&2; exit 2; }
read_var() { sed -n "s/^$1=//p" .dev.vars | tr -d '"'"'"' \r'; }
CID=$(read_var UBER_CLIENT_ID)
CSEC=$(read_var UBER_CLIENT_SECRET)
CUST=$(read_var UBER_CUSTOMER_ID)
WSEC=$(read_var UBER_WEBHOOK_SECRET)
for pair in "UBER_CLIENT_ID:$CID" "UBER_CLIENT_SECRET:$CSEC" "UBER_CUSTOMER_ID:$CUST" "UBER_WEBHOOK_SECRET:$WSEC"; do
  [ -n "${pair#*:}" ] || { echo ".dev.vars ${pair%%:*} is missing" >&2; exit 2; }
done

echo "→ applying migrations to the production D1 (adds deliveries + the courier outbox kind)"
npx wrangler d1 migrations apply bullandbloom --remote 2>&1 | grep -Ev '^\s*$' | tail -n 5

echo "→ uploading secrets to Cloudflare"
printf '%s' "$CID"  | npx wrangler secret put UBER_CLIENT_ID      2>&1 | grep -E "Success|rror" || true
printf '%s' "$CSEC" | npx wrangler secret put UBER_CLIENT_SECRET  2>&1 | grep -E "Success|rror" || true
printf '%s' "$CUST" | npx wrangler secret put UBER_CUSTOMER_ID    2>&1 | grep -E "Success|rror" || true
printf '%s' "$WSEC" | npx wrangler secret put UBER_WEBHOOK_SECRET 2>&1 | grep -E "Success|rror" || true

echo "→ redeploying with SITE_URL=$PREVIEW and Robocourier on (sandbox only)"
# --var replaces the whole [vars] block for this deploy, so SITE_URL has to be repeated here.
npx wrangler deploy --var "SITE_URL:$PREVIEW" --var "UBER_ROBOCOURIER:1" 2>&1 | grep -E "Uploaded|Deployed|workers.dev|rror" || true

echo "→ checking the deployed Worker"
echo "  health: $(curl -sS "$PREVIEW/api/health")"
echo "  config: $(curl -sS "$PREVIEW/api/config" | tr -d '\n' | sed 's/.*"delivery"/delivery/')"
echo
echo "Done. Open $PREVIEW/admin/ → Delivery; it should say Uber is set up."
echo "PRODUCTION LATER: re-run wrangler secret put with the live values and redeploy WITHOUT --var UBER_ROBOCOURIER."
```

Then:

```bash
chmod +x scripts/uber-setup.sh
scripts/uber-setup.sh
```

Migration order matters, as in Plan 2: `0003_delivery.sql` lands before the new code deploys, so a webhook arriving mid-deploy never hits code expecting a table the database lacks. The `outbox` rebuild inside that migration copies existing rows, so any Plan 2 message still queued survives.

- [x] **Step 4: Acceptance walk-through (spec §4.6 "Uber: sandbox credentials plus Robocourier")**

On the preview, with a day open and capacity free:

1. **Quote at checkout.** On the storefront choose Delivery and type a real address inside Anthony's region. Expected: "Delivery $X" within a second or two, the total line showing bouquet + delivery, and the Continue button enabling. Type an address across the country: "outside our delivery area" (or the fallback fee, if that ZIP is on the list) and the button disables.
2. **Buy it.** Pay with `4242 4242 4242 4242`. Expected: the order appears in admin for that day as `paid · delivery` with the address; the confirmation email says "Delivering to: …" and lists Bouquet, Delivery and Total; Anthony's copy and the Orders-calendar event both carry the address (spec §6).
3. **Request courier.** In admin, press Request courier. Expected within seconds: the line becomes "Courier: pending · $Y track", a tracking email arrives at the customer address with a working `direct.uber.com` link, and the Delivery panel's variance total moves by `$Y − $X`.
4. **Robocourier runs it.** The sandbox courier walks the statuses on its own. Refresh the day every 30 seconds or so: `pickup` → `pickup_complete` → `dropoff` → `delivered`, and on `delivered` the order flips to `done`. If the statuses do not move, check the Uber dashboard's webhook delivery log for non-2xx responses — a signature mismatch shows there as a 400.
5. **Cancellation path.** Create a second delivery order and dispatch it; in the Uber dashboard cancel that delivery (or dispatch with the Robocourier `cancel_reason` variant). Expected: the order stays `paid`, the line shows `canceled` with the reason, and the button comes back as **Request another courier**.
6. **Dispatch failure.** Temporarily set `UBER_CUSTOMER_ID` to a wrong value with `wrangler secret put`, request a courier, and confirm the button reports the error in place and the order stays `paid` with no delivery row. Put the real value back.
7. **Plan 1 and 2 regression.** Buy a pickup bouquet; close a day from the Closed calendar; confirm both still behave.

Record which of these passed, with dates, in the spec's §8.

- [x] **Step 5: Record and commit**

`README.md` — under "Local development" step 1, name the ten secrets and add:

```markdown
The four `UBER_*` values are optional locally; without them delivery falls back to the flat fee and ZIP list in `store.config.json`, and the admin Delivery panel says Uber is not set up.
```

Under "Deploy" add:

```markdown
Uber: `scripts/uber-setup.sh` uploads the four Uber secrets, applies migrations, and redeploys the preview with `UBER_ROBOCOURIER=1` (sandbox self-driving couriers). The Uber dashboard's webhook endpoint must be `<site>/webhooks/uber` for both the preview and thebullandbloom.com. Moving to Anthony's production organisation is a secret swap plus a redeploy without `UBER_ROBOCOURIER`.
```

And extend the rate-limiting sentence, since `/api/quote` now calls a paid third party on every keystroke-settled address:

```markdown
Rate limiting for `/admin/api/login`, `/api/checkout` and `/api/quote` is configured as Cloudflare rules at deploy, not in code.
```

Spec `docs/superpowers/specs/2026-09-07-store-design.md`:

- §3: add rows D26–D32, copied from this plan's decisions table with any outcome noted.
- §4.3: the `deliveries` row now reads `order_id, uber_delivery_id, status, quoted_cents, fee_cents, tracking_url, created_at, updated_at, last_error` — `actual_cents` was renamed `fee_cents` to match Uber's own field (D27).
- §7: under "Config Anthony supplies", split "studio ready time for courier pickup" into the four things Task 2 actually needs — ready time, the studio's street address for the courier, a phone the courier can call, and the fallback ZIP list and flat fee.
- §8: append Plan 3's verification results from Step 4, including the date the production Uber application was filed.
- §9: update the outcome paragraph — what Anthony would notice now.

```bash
git add scripts/uber-setup.sh README.md docs/superpowers/specs/2026-09-07-store-design.md store.config.json
git commit -m "chore(uber): setup script, deploy notes, and spec decisions D26–D32"
```

- [ ] **Step 6: Staging review call**

Post the staging review call to Ryan per the MeOS release rule: what is on the preview, what Anthony would notice (product language, no git), what is close behind, and a recommendation. Plan 4 (subscriptions) or the DNS cutover is next; cutover still needs Anthony's real prices, cap, pickup text, the live Stripe key, and now his production Uber organisation (spec §7).

---
## Self-review

**Spec coverage for Plan 3's scope.**

- **§2 item 6 (Delivery: Uber quote at checkout keyed on the address; courier requested by Anthony with one tap on the day; pickup free).** Quote: Tasks 5, 10. Locked on the order: Task 6. One tap: Tasks 8, 11. Pickup unchanged: Task 6's regression test and Task 10 Step 5 item 4.
- **§2 item 8 (admin "request courier", delivery fee variance total).** Task 8 (`/dispatch`, `varianceTotal`), Task 11 (the button and the Delivery panel). The month grid, close-a-day, cap edit, and "done" are Plan 1's and are untouched; the subscriber list is Plan 4's.
- **§2 item 10 (courier tracking email).** Tasks 3 (the outbox kind), 7 (the template and the drain case), 8 (the enqueue). It goes out through Plan 2's Gmail adapter and outbox, so it retries and shows in admin's waiting/failed counts like every other message.
- **§4.2 (repo config: fallback flat delivery fee and zip list; studio ready time).** Task 2, plus `studio.phone` and a structured `studio.address` that §4.2's "studio pickup address" implies once a courier has to find it (D26). §7's config list is amended in Task 12 Step 5.
- **§4.3 (`deliveries` table; `orders.uber_quote_id`, `address_json`).** Task 3, with `actual_cents` renamed `fee_cents` (D27) and `id`/`created_at`/`last_error` added; the spec text is updated in Task 12 Step 5. `address_json` is written in Task 6 and read in Tasks 7, 8, 11.
- **§4.4 "Quote" (`POST /api/quote {address, date}` → pickup = studio, dropoff = address, pickup_ready = date at the studio's ready time; returns fee cents and quote id, or `unavailable`; client shows "Delivery $X" or "outside our delivery area, choose pickup").** Task 5 for the endpoint, Task 10 for both client strings. One deviation, deliberate: the response carries `quoteToken` rather than a bare `quoteId`, and checkout reads the fee from the token (D31). The quote id is still stored on the order, as §4.3 asks.
- **§4.4 "Checkout" (`{…, fulfillment, address?, quote_id?, …}`, line items bouquet + delivery).** Task 6. The `quote_id?` field is the signed token (D31); the address is a structured object rather than a free string.
- **§4.4 "Courier request" (admin → fresh quote → create delivery → store `deliveries` row, email the tracking URL; Uber status webhooks update the row; `delivered` marks the order `done`; variance = actual − quoted, summed on admin).** Tasks 8 and 9. "Or calendar link" resolves to the calendar description's existing `#YYYY-MM-DD` admin deep link (Plan 2 Task 11), which now opens a day whose delivery orders carry the button — no new link is needed.
- **§4.5 Uber rows.** "Quote fails or region unsupported → delivery option hides; pickup remains; if repo config has a fallback zip list, flat-fee delivery shows instead": Task 5's three branches and Task 10's `deliveryOffered`. "Dispatch fails → admin shows error; Anthony retries or delivers himself; order stays `paid`": Task 8's 502 path, asserted, and Task 11's in-place message.
- **§5 `adapters/uber` (`quote(pickup, dropoff, readyAt)`, `createDelivery(quoteId, order)`, `verifyWebhook`).** Tasks 1 and 4. `readyAt` became a whole `DeliveryWindow` because Uber requires four timestamps with interlocking constraints, not one.
- **§5 `routes/webhooks` uber.** Task 9.
- **§6 Anthony's day ("his phone calendar lists today's orders with size, note, and pickup **or address**… for each delivery he taps request courier; the customer gets a tracking email").** Task 7 puts the address in the calendar description and Anthony's copy; Tasks 8 and 11 are the tap; Task 7 is the email.
- **§7 item 1 (Uber Direct eligibility; sandbox immediate, production needs approval; if ineligible, fall back to flat fee + zip list).** Task 12, which makes the sandbox-now / production-later split explicit and names the fallback as a shippable outcome.
- **D8 (fee locked at order time; variance on Anthony, tracked in admin).** Task 6 locks it, Task 8 never touches it, Tasks 3 and 11 total the variance. It is also a Global Constraint so no later task can quietly break it.
- **D24 (all-day calendar events).** Unchanged; the studio ready time now exists in config, and D24's note that it did not is superseded — the event stays all-day because that is still what a phone's day view lists as a checklist.
- **Explicitly not in this plan:** D7 and D14 and §2 item 5 (subscription delivery add-on, materialization) — Plan 4; §2 item 7 Instagram — Plan 5; §4.7's DNS cutover.

**Placeholder scan.** No "TBD", "handle errors appropriately", or "similar to Task N" — every task carries the code it needs, repeated where two tasks need the same snippet (the admin login helper appears in full in Task 8's test file rather than being cross-referenced). Three things look like placeholders and are not: the `SAMPLE —` strings in `store.config.json` are the same spec §7 blanks Plans 1 and 2 shipped with, and Task 12 Step 1 makes replacing them a gate before any real courier; the `.dev.vars` values are gitignored by design; and the empty **"Decisions Ryan made (pending)"** section is deliberate — it is filled in from Ryan's answers before execution starts, exactly as Plan 2's was. The unverified Uber facts are each named in Global Constraints with what happens if they are wrong, rather than being silently assumed.

**Type consistency.** `Uber`, `UberQuote`, `UberDelivery`, `QuoteRequest`, `DeliveryRequest`, `DeliveryWindow`, `Party`, `UberError`, `UberFailureCode` and `verifyUberSignature` are defined once in Task 1 and used unchanged in Tasks 4, 5, 8, 9. `PostalAddress` is defined once in `src/config.ts` (Task 2) and consumed by Tasks 1, 4, 5, 6, 7 — Task 1 carries the note about which task creates it if the executor runs them out of order. `Delivery`, `NewDelivery`, `DeliveryStatus`, `TERMINAL_STATUSES`, `insertDeliveryStatement`, `insertDelivery`, `activeDeliveryFor`, `deliveriesForDate`, `applyStatus` and `varianceTotal` come from Task 3 and are called with those names in Tasks 7, 8, 9, 11. `NewDelivery`'s field is `at` (one timestamp, written to both `created_at` and `updated_at`) in Task 3's implementation, Task 7's tests and Task 8's dispatch. `OutboxKind` gains `"courier_email"` in Task 3 and is switched on in Task 7. `enqueueCourierEmailStatement(db, orderId, now)` has that signature in Tasks 3, 7 and 8. `Order.uberQuoteId` and `NewOrder.addressJson`/`NewOrder.uberQuoteId` are added in Task 3 and populated in Task 6; `markDoneIfPaid` is added in Task 9. `QuoteClaim`'s fields (`feeCents`, `quoteId`, `kind`, `date`, `addr`, `exp`) are written in Task 5 and read in Task 6. `addressKey` produces the value that both `signQuote` and checkout's comparison use. `deliveryWindow(pickupReadyAt, now)` takes the same two arguments in Tasks 5, 8. `deliveryAddressOf`/`formatAddress` are defined in Task 7 and used by Tasks 8 and 11 (the admin page reimplements the formatting in ES5 because it cannot import from `src/`, which is the same split Plan 1 accepted for `humanDate`). `testApp()` returns `{ app, payments, google, uber, fetch }` and `testServices()` returns `{ services, payments, google, uber }` from Task 1 onward, used that way in Tasks 5, 6, 8, 9. The API shapes the storefront and admin page consume — `{ available, feeCents, kind, quoteToken }`, `{ available: false, reason }`, `{ orders, deliveries }`, `{ configured, fallbackFeeCents, fallbackZips, variance }`, `{ ok, delivery, variance }` — are the exact objects Tasks 5 and 8 return.

**One thing an executor should watch.** Tasks 1 and 2 both touch `src/config.ts`, and Task 3 and Task 6 both touch `src/store/orders.ts` and `src/routes/public.ts`. Run the tasks in order; if a review gate sends one back, re-read the current file rather than reapplying the plan's snippet, since the snippets are written against the state at the start of their own task.
