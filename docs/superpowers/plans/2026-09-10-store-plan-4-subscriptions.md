# Store Plan 4: Subscriptions (size × cadence grid, Stripe subscriptions, nightly materialization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell the weekly and twice-monthly bouquet as a Stripe subscription from the storefront, and make every subscriber's bouquet show up where Anthony already works: the Orders calendar, the admin day panel, and (later) the courier flow. Customers manage pause, cancel, and card through Stripe's portal; Anthony sees a subscriber list in admin.

**Why now (2026-09-10):** The road test closed Plan 2. Anthony asked for weekly (four a month) and twice-a-month options on the drive; the inquiry form is the only subscription path today. Delivery (Plan 3, Uber) is not merged, so this plan ships **pickup subscriptions** and leaves a seam for the delivery add-on (spec D7).

**Architecture:** Same Worker. New `subscribers` table in D1; a nightly cron materializes each active subscriber's upcoming bouquets as `orders` rows with `source = 'subscription'` (spec §4.4 "Subscriber materialization"), which flow through the existing outbox for calendar events. Stripe Checkout in `subscription` mode with ad-hoc recurring `price_data` from `store.config.json` (no products to keep in sync in the Stripe dashboard). Pure cadence and D13 shifting logic in `src/core/subscriptions.ts`.

**Tech Stack:** unchanged (Workers, D1, Hono, Stripe SDK fetch client, Vitest workers pool).

**Spec:** `docs/superpowers/specs/2026-09-07-store-design.md` §2 item 5, §4.4 "Subscription signup" and "Subscriber materialization", D7, D13, D14. Task 1 (config grid) landed 2026-09-10 in `store.config.json` with SAMPLE prices.

## Global Constraints

- Everything in Plans 1–2's Global Constraints still holds (dates as `YYYY-MM-DD` in `America/New_York`, integer cents, core imports nothing from adapters/store/Hono, `npm test` and `npm run typecheck` green per task).
- Subscriber bouquets never consume the daily cap (D14). Every capacity query already filters `source = 'one_time'`; this plan must not loosen that. Admin shows `+n` per day, which Plan 1 already renders from `subscriptionCount`.
- Stripe is the source of truth for whether a subscription is active and paid. D1 `subscribers.status` mirrors Stripe webhooks; the store never bills anything itself.
- Materialized orders are `paid` with `bouquet_cents = 0` and `stripe_session_id = NULL`, never `held`. Their money lives on the subscription, not the order.
- A subscriber's bouquet on a closed day moves to the next open day in the same Mon–Sun week; a fully closed week is skipped and flagged for Anthony (D13). Shifting is a pure function with tests before any job code.
- Pickup only in this plan. `fulfillment = 'pickup'`, `delivery_add_on_cents = 0`. The column and the quote seam exist so Plan 3 adds delivery without a schema change.
- No new secrets. Stripe customer portal needs one dashboard setting (Task 10) and no code secret.

## Decisions made while planning (engineering internals; Ryan can veto any)

| # | Decision | Alternatives | Why |
|---|---|---|---|
| D26 | Cadence `twice-monthly` means every other week from the anchor date (weeks 1, 3, 5 …), not "1st and 15th". | Fixed calendar dates; first and third occurrence of the weekday | A florist's week is the unit; every-other-week keeps the same weekday and never lands twice in eight days. Stripe still bills monthly. |
| D27 | Stripe subscription prices are ad-hoc `price_data` (monthly, USD, amount from config) on Checkout, keyed by `metadata.cell = "<sizeId>/<cadenceId>"`. | Pre-created Products and Prices in the dashboard | Zero dashboard upkeep: a config change is a deploy, and Anthony never touches Stripe. Stripe creates the Product once per distinct amount. |
| D28 | The subscriber row is created from `checkout.session.completed` (mode `subscription`) using `session.subscription` and `session.customer`, and status thereafter follows `customer.subscription.updated` / `.deleted`. | Create on `customer.subscription.created` | The session carries our metadata (cell, weekday, name, phone) and the customer email in one event; `subscription.created` can arrive before the session event and carries none of it. |
| D29 | Materialization runs nightly (03:15 Eastern) 21 days ahead and is idempotent on `(subscriber_id, due_date)`; a materialized order stays even if the subscription cancels later that week (Anthony decides in admin). | Materialize on signup only; materialize 14 days | 21 days keeps three weeks visible on the calendar for planning; idempotency by unique index means the job can run any number of times. |
| D30 | Pause is a per-week skip Anthony sets in admin (`paused_weeks_json`), plus Stripe's own pause/cancel via the portal, which stops billing and materialization. No customer self-serve "skip a week" in v1. | Portal-only; customer skip UI | Stripe's portal cannot skip a single delivery. Spec §8 already gives admin a per-week pause. |
| D31 | Signup confirmation email carries the portal link; each materialized bouquet gets a calendar event but **no** email (Anthony sees it on the calendar; the customer knows their cadence). | Email every week | Spec §2 item 10 lists confirmations and courier tracking only; weekly emails are noise for a standing order. |

## Pending decisions for Ryan (answer before Task 6)

1. **Prices per cell.** ANSWERED 2026-09-10: the six numbers in `store.config.json` are approved as-is (Posy $185/$100, Bouquet $290/$155, Statement $460/$245 for weekly/twice-monthly). One-time prices remain SAMPLE.
2. **Anchor rule.** First bouquet is the first open occurrence of the chosen weekday at least 3 days after signup (proposed). OK, or a different lead time?
3. **Twice-monthly meaning.** D26 (every other week). Veto if Anthony thinks of it as fixed dates.
4. **Storefront placement.** Proposed: the subscription grid replaces the "Ask about a subscription" inquiry form; the inquiry form stays for custom arrangements under Contact. Or keep both.
5. **Cancellation copy.** Portal link text and the "we'll miss you" line in the cancellation email (Task 8 drafts them; Ryan approves like Plan 2's).

---

## File structure

```
store.config.json                       subscriptions.cadences / cells (landed 2026-09-10)
migrations/0003_subscribers.sql         subscribers table; unique (subscriber_id, date) on orders for materialized rows
src/config.ts                           Cadence, SubscriptionCell, subscriptionCell() (landed)
src/core/subscriptions.ts               dueDates(), shiftForClosed() (D13), nextAnchor()
src/store/subscribers.ts                typed D1 queries: insert, byStripeSubscription, setStatus, list, pausedWeeks
src/adapters/payments.ts                + createSubscriptionCheckout(), portalLink(), subscription webhook events
src/adapters/stripe.ts                  real implementation
src/routes/public.ts                    + POST /api/subscribe, GET /api/config exposes the grid
src/routes/webhooks.ts                  + subscription events (D28)
src/jobs/materialize.ts                 nightly materialization with D13, enqueue calendar events via outbox
src/scheduled.ts                        + materialize at 03:15 ET (cron "15 7 * * *" UTC; DST drift accepted)
src/core/messages.ts                    + subscription confirmation and cancellation templates
src/routes/admin.ts                     + /admin/api/subscribers, per-week pause, flagged weeks
site/index.html, site/store.js          subscription grid + signup form
site/admin/index.html                   Subscribers panel; day panel lists subscription bouquets
tests/…                                 one test file per module above
```

## Tasks

### Task 1: Config grid — DONE 2026-09-10
`store.config.json` has `subscriptions.cadences` and `cells`; `src/config.ts` validates ids, cross-references, duplicates, prices; `tests/config.test.ts` covers it.

### Task 2: Schema — DONE 2026-09-10
- [x] `migrations/0003_subscribers.sql`: `subscribers (id TEXT PK, stripe_customer_id, stripe_subscription_id UNIQUE, size_id, cadence_id, weekday INTEGER, fulfillment, address_json, delivery_add_on_cents INTEGER DEFAULT 0, status CHECK IN ('active','paused','cancelled'), anchor_date TEXT, paused_weeks_json TEXT DEFAULT '[]', customer_name, customer_email, customer_phone, created_at INTEGER)`; `CREATE UNIQUE INDEX orders_subscriber_date ON orders (subscriber_id, date) WHERE subscriber_id IS NOT NULL`.
- [x] `tests/store/subscribers.test.ts` (with Task 4).

### Task 3: Core cadence logic (pure) — DONE 2026-09-10
- [x] `nextAnchor(weekday, signupYmd, openSet, leadDays)`: first date ≥ signup + leadDays on that weekday.
- [x] `dueDates(sub, fromYmd, toYmd)`: weekly = every 7 days from anchor; twice-monthly = every 14 days (D26); excludes weeks in `pausedWeeks` (ISO Monday keys).
- [x] `shiftForClosed(date, closedSet, openWeekdays)`: next open day in the same Mon–Sun week, else `{ skipped: true }` (D13).
- [x] Tests with fixed dates covering DST weeks, a closed week, a paused week.

### Task 4: Subscriber store — DONE 2026-09-10
- [x] `src/store/subscribers.ts` and tests: insert, `byStripeSubscription`, `setStatus`, `list(status?)`, `setPausedWeeks`, `materializedCount(subscriberId, from, to)`.

### Task 5: Payments adapter — DONE 2026-09-10 (Stripe calls unverified until Task 12)
- [x] `Payments.createSubscriptionCheckout({ cell, amountCents, customerEmail, metadata, successUrl, cancelUrl })` → `{ id, url }`, mode `subscription`, `line_items[0].price_data.recurring.interval = 'month'`, `subscription_data.metadata`.
- [x] `Payments.portalLink(customerId, returnUrl)` → url.
- [x] `WebhookEvent` gains `subscription_started` (from a mode-subscription `checkout.session.completed`), `subscription_updated` (status), `subscription_deleted`.
- [x] `RecordingPayments` in `tests/helpers.ts` records these; `tests/adapters/stripe.test.ts` covers the event mapping with recorded fixtures.

### Task 6: Signup endpoint
- [ ] `POST /api/subscribe { sizeId, cadenceId, weekday, customer: { name, email, phone? }, note? }` → validates against the grid and `openWeekdays`, creates the Checkout session with metadata, returns `{ url }`. No D1 row yet (D28).
- [ ] `GET /api/config` adds `subscriptions: { cadences, cells }` and `openWeekdays` so the storefront can render the grid.
- [ ] Tests: unknown cell 400, closed weekday 400, happy path records metadata.

### Task 7: Webhooks
- [ ] `subscription_started`: insert `subscribers` (status active, anchor via Task 3, customer fields from the session), enqueue a `subscription_confirmed` outbox row (customer email with portal link, owner copy), then materialize this subscriber immediately (Task 9's function) so the first bouquets appear the same minute.
- [ ] `subscription_updated`: mirror `active`/`paused` (Stripe `pause_collection`) and `past_due` → `paused`.
- [ ] `subscription_deleted`: status `cancelled`; delete future materialized orders for that subscriber dated after today; enqueue the cancellation email.
- [ ] Idempotent on `stripe_subscription_id`. Tests for each event and for a replay.

### Task 8: Messages
- [ ] `subscriptionConfirmedEmail`, `subscriptionCancelledEmail`, `ownerSubscriptionEmail` in `src/core/messages.ts`; outbox kinds added in `src/store/outbox.ts` and delivered in `src/jobs/outbox.ts`. Materialized bouquets reuse `orderEvent` with the title "Bouquet · Pat Smith · pickup (subscription)".
- [ ] Tests render each template once against a fixed subscriber.

### Task 9: Materialization job
- [ ] `materializeSubscriptions(deps, now)`: for each active subscriber, for each due date in `[today, today + 21d]` after `shiftForClosed`, insert a `paid` order with `source = 'subscription'`, `bouquet_cents = 0`, and an outbox calendar-event row, ignoring unique-index conflicts; skipped weeks are written to `settings` key `subscriptions.flags` for admin.
- [ ] `src/scheduled.ts`: run it on the 03:15 ET cron tick (`wrangler.toml` gains `"15 7 * * *"`; the 15-minute cron keeps doing its jobs).
- [ ] Tests: idempotent re-run, closed-day shift, whole-week skip flag, cancelled subscriber untouched.

### Task 10: Admin
- [ ] `GET /admin/api/subscribers` (active first), `PUT /admin/api/subscribers/:id/pause { week, paused }` (rewrites that week's materialized order: delete when pausing, materialize when unpausing), `GET /admin/api/subscribers/flags`.
- [ ] Admin page: Subscribers button → list with size, cadence, weekday, next bouquet, portal status, per-week pause toggles for the next 4 weeks; flagged skipped weeks at the top in the closed-day pink.
- [ ] Day panel already shows `(subscription)` on orders; make sure Mark done works for them (it does: status `paid`).
- [ ] Stripe dashboard (one-time, Ryan): enable the customer portal with cancel and pause allowed, update card on, return URL the site.

### Task 11: Storefront
- [ ] Replace the inquiry form (pending decision 4) with a grid: one card per cadence with the three sizes and monthly prices, a weekday picker limited to `openWeekdays`, name/email/phone, note, "Start subscription" → Stripe.
- [ ] `thanks.html` reads `?subscription=1` and says the first bouquet date will be in the email.
- [ ] Phone-size check with Playwright as on the 2026-09-10 road test (empty-field validation, grid renders from config).

### Task 12: Preview deploy and acceptance
- [ ] Stripe dashboard (Ryan): add `customer.subscription.updated` and `customer.subscription.deleted` to the webhook endpoint's events, or re-run `scripts/stripe-setup.sh` after extending its event list.
- [ ] Deploy through the GitHub Actions workflow (`.github/workflows/deploy.yml`, added 2026-09-10) to the preview URL.
- [ ] Stripe sandbox: sign up weekly Bouquet, Tuesday. Expect: subscriber row active, three orders materialized on the next three Tuesdays (+1 on each in admin), calendar events on the Orders calendar, confirmation email with a working portal link. Cancel from the portal: future orders removed, cancellation email arrives. Close one of those Tuesdays from Anthony's calendar: the bouquet moves to Wednesday overnight; close the whole week: flagged in admin.
- [ ] Record in spec §8/§9; add D26–D31 to §3.

## Self-review
Covers spec §2 item 5 entirely except the delivery add-on (D7), which waits for Plan 3's quote adapter and is stubbed at `delivery_add_on_cents = 0`. §4.4 "Subscription signup" (Tasks 5–7), "Subscriber materialization" (Task 9), D13 (Tasks 3, 9), D14 (constraint, unchanged queries). §8 subscriber list with per-week pause (Task 10). Stripe portal (Task 10 setting + Task 8 link). Type names introduced here (`Cadence`, `SubscriptionCell`, `Subscriber`, `WebhookEvent` variants) are defined once in Tasks 1, 4, 5 and used by name in later tasks.
