# Store Plan 5 — vase choice, sales tax, delivery zones, Uber back on

**Date:** 2026-09-15
**Status:** approved in conversation, awaiting Ryan's read of this document
**Owner:** Ryan Fuchs (build); Anthony Demonia (product owner, operator)
**Builds on:** `2026-09-07-store-design.md` (Plans 1–4) and the 2026-09-15 hot fixes
(`85127ac` flat delivery mode, `fd972b9` wider zip list, `0c7bc95` State prefilled).

## 1. Why

Anthony's first days on the live store surfaced four things: Stripe must collect New
York sales tax; customers need to choose between a hand-tied bouquet and one arranged in
a vase; delivery to the Saratoga and Hudson regions, which Anthony drives himself, has to
cover the drive from Albany; and Uber pricing has been off since cutover because the
Worker kept a sandbox login token after the production keys went in.

## 2. Decisions (all made 2026-09-15 with Ryan)

- **D33 Catalog stays in the repo file.** No Stripe Products, no admin editor. Prices are
  edited in `store.config.json` and deployed by a push to main.
- **D34 Vase is a per-size upcharge on one product, not a second product.** Hand-tied
  $55 / $85 / $135; in a glass vase +$15 / +$20 / +$25 (Posy / Bouquet / Statement).
  Research: plain-glass add-ons at comparable studios run $10–15 flat, ceramic $30–40;
  Anthony wants the high end. Subscriptions stay hand-tied.
- **D35 Delivery zones with their own fees replace the single zip list.** Capital
  District $10; Saratoga region $35; Hudson region $35. A 70-mile round trip at the
  standard mileage rate is about $49 before Anthony's time, so $35 is a floor, not a
  margin.
- **D36 Uber prices every delivery it will take; the zones are the fallback.**
  `delivery.mode` goes back to `"uber"`. If Uber quotes an address, the customer pays
  Uber's fee. If Uber refuses it or fails, the zone fee applies and Anthony drives. Ryan
  accepts Uber pricing for Saratoga and Hudson if Uber serves them.
- **D37 Stripe Tax on every Checkout Session.** Ryan has activated Stripe Tax and
  registered the New York tax id. Prices stay tax-exclusive; tax is added at checkout.
- **D38 The Uber token cache is bound to the client id that minted it.** A key change
  can never leave an old token in use again.
- **D39 The day grid stays.** No date picker. Three accessibility fixes only.
- **D40 Promotion codes are allowed on every Checkout Session.** Ryan creates codes in
  the Stripe dashboard (including 100% codes for live-mode testing); the Stripe page shows
  its "Add promotion code" field. The store records nothing about the code; Stripe's own
  discount shows in `total_details.amount_discount` and the paid total already reflects it.
- **Payment methods** are a dashboard setting, not code. Ryan has turned off Klarna, bank
  debits and Link.

## 3. What changes

### 3.1 Vase or hand-tied (one-time orders)

Config: each entry in `sizes[]` gains `vaseFeeCents`. Validation: non-negative integer.
`/api/config` returns it with the size.

Storefront (`site/index.html`, `site/store.js`): a "How it comes" fieldset of two pills
under Pickup or Delivery, radios `name="presentation"`, `hand-tied` checked by default,
`vase` labelled from config for the chosen size ("Arranged in a glass vase — +$20"). The
copy: "Hand-tied and wrapped, no vase" / "Arranged in a vase, ready to set
down." The total line lists parts: `Bouquet $85 + vase $20 + delivery $12 = $117`, and
ends "· tax added at checkout". Changing presentation never re-quotes delivery.

API (`POST /api/checkout`): body gains `presentation: "hand-tied" | "vase"`; missing
means hand-tied (old tabs keep working); anything else is 400. `vaseCents` is the chosen
size's fee or 0, stored on the order, and a "Vase" Stripe line item is added between the
bouquet and delivery lines.

Data: migration `0006_vase.sql`
```sql
ALTER TABLE orders ADD COLUMN presentation TEXT NOT NULL DEFAULT 'hand-tied'
  CHECK (presentation IN ('hand-tied','vase'));
ALTER TABLE orders ADD COLUMN vase_cents INTEGER NOT NULL DEFAULT 0;
```
`Order`, `NewOrder`, `tryInsertHeldOrder`, `fromRow` carry both. Materialized
subscription orders keep the defaults.

Everywhere the order is described says which it is: calendar event summary and
description, customer confirmation ("Your Bouquet, arranged in a vase, is booked…" with a
`Vase: $20.00` line), owner email subject, Anthony's admin order list (` · vase`), and the
courier manifest (`Bouquet — flowers in a vase`). The declared parcel value for Uber
becomes bouquet + vase.

### 3.2 Delivery zones

Config shape (replaces `fallbackFeeCents` / `fallbackZips`):
```json
"delivery": {
  "mode": "uber",
  "zones": [
    { "name": "Capital District", "feeCents": 1000, "zips": ["12202", "…"] },
    { "name": "Saratoga",         "feeCents": 3500, "zips": ["12866", "…"] },
    { "name": "Hudson",           "feeCents": 3500, "zips": ["12534", "…"] }
  ]
}
```
The 81 zips shipped on 2026-09-15 split by region as they were listed. Validation: each
zone has a non-empty name, a non-negative integer fee, five-digit zips, and no zip appears
in two zones. An empty `zones` list is allowed and means no fallback.

Core: `zoneFor(cfg, zip)` returns the zone or null; `fallbackFeeFor` becomes its fee.
`deliveryOffered` is "Uber configured, or any zone has zips". The fallback quote response
gains `zone: name`, and the storefront note reads "Delivery $35 (Hudson) — Anthony
delivers this one himself." Admin delivery status returns `zones`; the panel lists them:
"Capital District $10 (36 ZIPs) · Saratoga $35 (19 ZIPs) · Hudson $35 (26 ZIPs)".

Tests that read the repo config switch from `fallbackZips[0]` to `zones[0].zips[0]` and
`zones[0].feeCents`, plus one checkout test for a last-zone zip.

### 3.3 Stripe Tax

Adapter (`src/adapters/stripe.ts`): every Checkout Session (payment and subscription)
sets `automatic_tax: { enabled: true }`; every inline price sets
`tax_behavior: "exclusive"` and a `product_data.tax_code`. `CheckoutLineItem` gains
`taxCategory: "flowers" | "vase" | "delivery"`, mapped in the adapter:

| category | code | why |
|---|---|---|
| flowers, vase | `txcd_99999999` general tangible goods | no floral-specific code exists |
| delivery | `txcd_92010001` shipping | Stripe applies NY's taxable-delivery rule itself |

Tax location. New York sources the sale to where the flowers go, and gift buyers are
often out of state, so the billing address is the wrong input. For one-time orders the
adapter creates a Stripe Customer per order with `email`, `name` and a `shipping` address:
the delivery address for delivery orders, the studio address for pickup. The session
passes that `customer`; Stripe Tax uses the shipping address when one is present. Checkout
still collects the billing address it needs for the card. Subscriptions are pickup-only
and local: they rely on the billing address Checkout collects, no Customer pre-creation.

Webhook: `checkout.session.completed` now carries `total_details.amount_tax`; the event
gains `taxCents`, `markPaidBySession` stores it, migration `0007_tax.sql` adds
`orders.tax_cents` and `orders.discount_cents`, both `INTEGER NOT NULL DEFAULT 0`. The
stored `amount_total` already includes tax. The same migration adds
`orders.discount_cents`, filled from `total_details.amount_discount`, so a promotion code
(D40) shows as `Discount: -$x` in the customer email and the emailed total is bouquet +
vase + delivery − discount + tax, which is exactly what Stripe charged. The customer email
shows `Sales tax: $x` and a total including tax.

Dashboard (Ryan, done or in progress): Stripe Tax active, Albany origin address, New York
registration, preset product tax code. Without the registration Stripe collects zero
silently. Fee: 0.5% per taxed transaction.

### 3.4 Uber token cache

`CachedToken` gains `clientId`. `load()` returns null when the stored client id differs
from the adapter's, and `save()` records it. The row minted 2026-09-09 by the sandbox app
has no client id, so the first production call after deploy re-mints. No manual database
edit is needed; the earlier `DELETE FROM settings` instruction is superseded.

### 3.5 Promotion codes

`createCheckout` and `createSubscriptionCheckout` pass `allow_promotion_codes: true`.
Nothing else changes: a 100% code still completes the session and fires
`checkout.session.completed`, so a live-mode test order flows through the store exactly
like a paid one (hold → paid → emails → calendar). Anthony fulfils it or cancels it from
admin like any other.

### 3.6 Day grid accessibility

Each day input gets an `aria-label` with the full date and remaining count ("Wed Sep 16,
2 left" / "sold out"); the S M T W T F S headers get full weekday names; `#day-note`
announces the chosen day. No layout change.

## 4. Out of scope

Stripe Products as the catalog; an admin price editor; a vase option on subscriptions;
a date picker; ceramic or designed vessels (a later "vessel" option at about $40); a
per-region delivery day for batching Anthony's drives; turning Link off (dashboard).

## 5. Verification

- 303 existing tests stay green; new tests per section (config validation incl.
  duplicate zip, `/api/config` vase fee, checkout with and without vase, bad
  presentation 400, zone lookup incl. last zone, Stripe adapter passes automatic tax +
  codes + customer shipping address, webhook stores tax cents, messages mention vase and
  tax, token cache ignores a foreign client id, deliveryItemName both values).
- On the preview (workflow_dispatch): a vase + delivery order to a Capital District
  address quotes from Uber (log shows no `customer_blocked`), Checkout shows tax, the
  paid order row has `vase_cents`, `tax_cents`; a 100% promotion code completes checkout
  and the order goes paid; a Saratoga address either quotes from Uber
  or falls back to $35 with the zone named; a Hudson address likewise.
- On production after the push to main: the same three quotes via curl, and the first
  real order's tax line checked in Stripe.
