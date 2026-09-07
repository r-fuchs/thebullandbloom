# The Bull and Bloom — online store design

**Date:** 2026-09-07
**Status:** approved in conversation, awaiting Ryan's read of this document
**Owner:** Ryan Fuchs (build); Anthony Demonia (product owner, operator)

## 1. Why

The Bull and Bloom is a one-person floral studio in upstate New York. Today the
site is a single static page; every order is an email, phone call, or Instagram
DM, and payment happens in person through the Jim tap-to-pay app. Anthony wants
to sell online following the solo-florist playbook from @littlebirdbloom: a tiny
designer's-choice menu, set order days with a cutoff, delivery charged
separately, and prices a notch below her recommendations.

The store must fit a one-man show. Every design choice below is judged against
one question: does this add a tool Anthony has to learn or a step he has to
remember? If yes, it needs a strong reason.

## 2. What (scope)

In scope for v1:

1. **Storefront**: the existing single page extended with an Instagram photo
   carousel, a three-size designer's-choice menu, a subscription grid, and a
   four-step order flow.
2. **Capacity**: one daily pool of N bouquets; same-day orders draw from the
   same pool and are offered only before a cutoff time; open weekdays are
   configurable; per-day overrides.
3. **Blackouts**: Anthony closes days either from the admin page or by adding
   any event to a dedicated Google Calendar ("Bull and Bloom: Closed").
4. **Checkout**: Stripe Checkout (hosted) for one-time orders. Jim stays for
   in-person sales; the store never touches Jim.
5. **Subscriptions**: a size × cadence grid sold as Stripe subscriptions.
   Nightly materialization of subscriber bouquets into the daily pools.
   Customers self-serve pause/cancel/card via Stripe's customer portal.
6. **Delivery**: Uber Direct quote at checkout keyed on the customer's address;
   courier requested by Anthony with one tap on the day. Pickup is free.
7. **Instagram carousel**: official Instagram API, polled every six hours,
   images cached in our storage, per-post hide switch in admin.
8. **Admin page**: one passcode-protected page. Month grid with counts, close a
   day, edit cap, orders per day with "request courier" and "done", subscriber
   list with per-week pause, Instagram connect and hide list, delivery fee
   variance total.
9. **Anthony's calendar view**: every confirmed order is written to a second
   Google Calendar ("Bull and Bloom: Orders").
10. **Email**: confirmations and courier tracking sent from
    thebullandbloom@gmail.com via the Gmail API, under the same Google
    authorization as the calendars.

Out of scope for v1 (explicit non-goals):

- Custom arrangements, weddings, events: stay as the inquiry form.
- Stem or color selection beyond a free-text note.
- Customer accounts or logins. Stripe's portal is the only customer self-service.
- Any Jim integration. Jim has no API, webhooks, or web checkout (verified
  2026-09-07: payment links are created one at a time in the mobile app).
- Automatic courier dispatch on a timer.
- SMS. Email only in v1.
- Multi-florist or multi-location.

## 3. Decisions made in the brainstorm

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| D1 | Online payment through Stripe; Jim stays for in-person | Pay-at-handoff via Jim only; Anthony texts a Jim link per order; move Anthony to Square | Jim cannot be integrated. Prepayment removes no-show risk on perishable made-to-order goods and makes subscriptions native. Square would have unified systems but forces Anthony to re-onboard. |
| D2 | Fixed prices Anthony sets, not formula-computed | Littlebirdbloom's wholesale × multiplier + markup | Ryan's call. Prices are informed by her recommendations but stored as plain numbers. |
| D3 | One daily pool; same-day counts against it | Separate same-day allowance; no same-day | Simplest to explain and to admin. |
| D4 | Order truth in the backend database; calendars are a view and a blackout input | Google Calendar as the ledger | Concurrency: two customers must not both buy the last slot. Holds need a database. |
| D5 | Blackouts from admin toggle OR Closed calendar, union | Admin only; calendar only; text-message commands | Calendar matches how Anthony already plans his time; admin toggle is the fallback that needs no Google. |
| D6 | Admin page exists alongside the calendar | Calendar as the only admin surface | Cap changes, order lists, courier requests, and Instagram hides need a real UI. |
| D7 | Subscription delivery fee is quoted once at signup and billed as a flat monthly add-on | Bill each week's actual Uber fee | Subscriptions need a fixed monthly amount; per-trip billing means variable invoices. Anthony can trigger a re-quote from admin. |
| D8 | Uber fee locked at order time; day-of variance lands on Anthony's margin, tracked in admin | Re-charge the customer the difference; add a buffer | Simplicity for the customer. Variance is small and visible. |
| D9 | Courier requested by Anthony, never on a timer | Auto-dispatch at a scheduled time | A courier must not arrive before the bouquet exists. |
| D10 | Static site + Cloudflare Pages/Workers/D1/R2 | Hosted platform (Shopify, Square Online); full custom server | Keeps the existing site; zero hosting cost; every integration is a thin adapter. Platforms fight the daily cap and calendar blackouts and cost $60–90/mo. A server is ops overhead for a handful of orders a day. |
| D11 | Email via Gmail API on the existing Google grant | Resend, Postmark, Stripe receipts only | No third vendor; one authorization by Anthony covers calendar and mail. |
| D12 | Instagram images copied into our storage | Link to Instagram's CDN URLs | Instagram media URLs expire; the page must not depend on Instagram being up. |
| D13 | Subscriber bouquet on a closed day moves to the next open day that week; whole week closed → skipped and flagged | Skip immediately; credit automatically | Keeps the promised cadence when possible; makes Anthony decide the rare full-week case. |

## 4. How

### 4.1 Architecture

```
Browser ── static HTML/CSS/JS (Cloudflare Pages)
   │  fetch /api/*
   ▼
Cloudflare Worker (Pages Functions)
   ├─ core/        pure logic: capacity, holds, cutoff, blackout merge, subscription layout
   ├─ store/       D1 (SQLite): orders, holds, day_overrides, blackouts, subscribers,
   │               deliveries, ig_posts, settings
   ├─ adapters/    stripe · uber · google (calendar + gmail) · instagram · r2
   ├─ routes/      /api/availability /api/quote /api/checkout /api/feed
   │               /webhooks/stripe /webhooks/uber /admin/*
   └─ cron/        every 15m: read Closed calendar
                   every 6h: refresh Instagram feed
                   nightly:  materialize subscriber bouquets, expire holds
                   monthly:  refresh Instagram token
```

Every adapter is a module behind an interface with a fake implementation for
tests. Core logic never imports an adapter.

### 4.2 Configuration

Two layers:

- **Repo config** (`store.config.json`, committed; changes are a deploy):
  studio pickup address, timezone (`America/New_York`), menu sizes (id, name,
  description, price cents), subscription grid (size ids × cadence ids with
  price cents per month), default daily cap, default cutoff time, default open
  weekdays, hold duration (30 min), Instagram poll interval, fallback flat
  delivery fee and zip list (used only if Uber is unavailable for the region).
- **Admin settings** (D1 `settings` table; changes are immediate): current
  daily cap, cutoff time, open weekdays, per-day overrides, closed days.

Config values Anthony still has to supply before launch are listed in §7.

### 4.3 Data model (D1)

- `orders` — id, created_at, status (`held` · `paid` · `done` · `cancelled` ·
  `refunded`), date, size_id, fulfillment (`pickup` · `delivery`),
  customer_name, customer_email, customer_phone, address_json, note,
  stripe_session_id, stripe_payment_intent, bouquet_cents, delivery_cents,
  uber_quote_id, source (`one_time` · `subscription`), subscriber_id nullable,
  calendar_event_id nullable.
- `holds` — order_id, date, expires_at. Deleted on confirm or expiry.
- `day_overrides` — date, cap nullable, closed boolean, source (`admin` ·
  `calendar`), calendar_event_id nullable.
- `subscribers` — id, stripe_customer_id, stripe_subscription_id, size_id,
  cadence_id, weekday, fulfillment, address_json, delivery_add_on_cents,
  status (`active` · `paused` · `cancelled`), anchor_date, paused_weeks_json.
- `deliveries` — order_id, uber_delivery_id, status, quoted_cents,
  actual_cents, tracking_url, updated_at.
- `ig_posts` — ig_id, permalink, caption, media_r2_key, taken_at, hidden.
- `settings` — key, value_json.

Capacity for a date = cap(date) − count(orders where date and status in
`held`,`paid`) where cap(date) is the override if present else the default,
and 0 if the day is closed or not an open weekday.

### 4.4 Flows

**Availability.** `GET /api/availability?from&to` returns, per date, `open`,
`remaining`, and whether today is still orderable (now < cutoff in studio
timezone and remaining > 0). The date picker renders only from this.

**Quote.** `POST /api/quote {address, date}` → Uber quote adapter with pickup
= studio, dropoff = address, pickup_ready = date at studio's configured ready
time. Returns fee cents and quote id, or `unavailable`. Client shows
"Delivery $X" or "outside our delivery area, choose pickup."

**Checkout.** `POST /api/checkout {size_id, date, fulfillment, address?,
quote_id?, note, customer}`:
1. Re-check availability inside a D1 transaction; insert order `held` and a
   hold row. Fail with `sold_out` if none.
2. Create Stripe Checkout Session with line items bouquet + delivery,
   `metadata.order_id`, success/cancel URLs, expiry = hold duration.
3. Return session URL; client redirects.

**Stripe webhook** `checkout.session.completed` → order `paid`, hold deleted,
Google Calendar event created on Orders calendar, confirmation emails to
customer and Anthony. `checkout.session.expired` → order `cancelled`, hold
deleted. Idempotent on session id.

**Hold expiry.** Nightly cron plus on-read: holds past `expires_at` cancel
their order and free the slot. Stripe's own session expiry is the primary
release; cron is the safety net.

**Blackout sync** (every 15 min). List events on the Closed calendar for the
next 90 days. For each day covered by any event, upsert `day_overrides`
closed=true source=`calendar`. Remove calendar-sourced overrides whose event
disappeared. Admin-sourced overrides are never touched by sync. On Google
failure keep the last state and log.

**Subscription signup.** Client posts grid choice, weekday, fulfillment,
address. If delivery: Uber quote → `delivery_add_on_cents` (D7). Create Stripe
Checkout in `subscription` mode with the grid price plus a recurring add-on
price for delivery created ad hoc. On `customer.subscription.created` insert
`subscribers`. On `customer.subscription.deleted`/`paused` update status.

**Subscriber materialization** (nightly). For each active subscriber, for
each due date in the next 14 days per cadence and anchor: if an order for that
subscriber/date does not exist, create one `paid` with source `subscription`,
applying D13 for closed days (move within the week, else skip and write an
admin flag). Materialized orders count against capacity ahead of one-time
orders because they are created before the day opens to the public.

**Courier request.** Admin or calendar link → `POST /admin/orders/:id/dispatch`
→ fresh Uber quote → create delivery → store `deliveries` row, email customer
the tracking URL. Uber status webhooks update `deliveries.status`; `delivered`
marks the order `done`. Fee variance = actual − quoted, summed on admin.

**Instagram refresh** (every 6 h). `GET /me/media` with fields id, media_type,
media_url, thumbnail_url, permalink, caption, timestamp. New posts: download
image (thumbnail for video/carousel) to R2, insert `ig_posts`. Feed endpoint
`GET /api/feed` serves non-hidden posts newest first with R2 URLs. Token
refresh monthly via the long-lived token refresh endpoint; failure emails
Ryan and Anthony with a reconnect link.

**Admin auth.** Private path plus a passcode. Passcode check sets a signed,
HttpOnly cookie valid 30 days. Rate-limited. No user accounts.

### 4.5 Failure modes

| Dependency | Failure | Behavior |
|---|---|---|
| Stripe | API down | Checkout button shows "payments are briefly unavailable, try again shortly." Hold not created. |
| Stripe | Webhook lost | Stripe retries; hold expires as safety net; admin shows `held` orders older than 30 min in red. |
| Uber | Quote fails or region unsupported | Delivery option hides; pickup remains. If repo config has a fallback zip list, flat-fee delivery shows instead. |
| Uber | Dispatch fails | Admin shows error; Anthony retries or delivers himself. Order stays `paid`. |
| Google Calendar | Unreachable | Blackouts use last synced state plus admin toggles. Order events queue and retry. |
| Gmail | Unreachable | Emails queue and retry; Stripe's own receipt still reaches the customer. |
| Instagram | Unreachable or token invalid | Carousel serves last cached set. Ryan and Anthony emailed once per failure day. |
| D1 | Write conflict on last slot | Transaction fails for the loser, who sees `sold_out`. |

### 4.6 Testing

- **Core** (capacity, cutoff, holds, blackout merge, subscription layout,
  D13 shifting): pure functions, unit-tested with fixed clocks, no network.
- **Routes**: tested against fake adapters and an in-memory D1 via Miniflare.
- **Stripe**: Stripe CLI webhook forwarding against test mode before launch.
- **Uber**: sandbox credentials plus Robocourier for the dispatch path.
- **Instagram**: recorded fixture of `/me/media`; live check once with
  Anthony's real token before launch.
- **Acceptance**: a scripted walk-through on staging covering one-time pickup,
  one-time delivery, subscription signup, closed day via calendar, closed day
  via admin, sold-out day, same-day past cutoff.

### 4.7 Hosting and deploy

Cloudflare Pages project connected to the GitHub repo; `main` deploys to
production, other branches to preview URLs. Workers, D1, and R2 bound to the
Pages project. DNS for thebullandbloom.com moves from GitHub Pages to
Cloudflare. That DNS change is the one manual step at launch and is Ryan's.
Secrets (Stripe, Uber, Google, Instagram, admin passcode) live in Cloudflare
environment secrets, never in the repo.

## 5. Modules and their contracts

| Module | Does | Depends on |
|---|---|---|
| `core/capacity` | remaining(date), isOrderable(date, now), applyOverrides | nothing |
| `core/subscriptions` | dueDates(subscriber, range), shiftForClosed(date, closedSet) (D13) | nothing |
| `store/*` | typed D1 queries; one transaction helper | D1 |
| `adapters/stripe` | createCheckout(one-time · subscription), verifyWebhook, portalLink | Stripe SDK |
| `adapters/uber` | quote(pickup, dropoff, readyAt), createDelivery(quoteId, order), verifyWebhook | fetch |
| `adapters/google` | listClosedEvents(range), createOrderEvent(order), sendMail(msg), token refresh | fetch, OAuth refresh token |
| `adapters/instagram` | recentMedia(token), refreshToken(token) | fetch |
| `adapters/r2` | putImage(key, bytes), publicUrl(key) | R2 binding |
| `routes/public` | availability, quote, checkout, feed | core, store, adapters |
| `routes/webhooks` | stripe, uber | store, adapters |
| `routes/admin` | auth, grid, day edit, orders, dispatch, subscribers, instagram | core, store, adapters |
| `cron` | blackout sync, feed refresh, materialize, expire holds, token refresh | store, adapters |
| `site/` | static pages and the order-flow JS | `/api/*` only |

## 6. Anthony's day (acceptance narrative)

Morning: his phone calendar lists today's orders with size, note, and pickup or
address. He makes them. For each delivery he taps "request courier" when the
bouquet is ready; the customer gets a tracking email. Pickups arrive. He may
tick "done." Going away: he adds a "Closed" event to the Closed calendar, or
toggles days in admin. A busy week: he raises the cap. Subscription questions
from customers: they use the Stripe portal link in their emails. New prices or
a new size: he tells Ryan; config change and redeploy.

## 7. Prerequisites and blanks to fill before build steps that need them

External accounts and approvals (real-world tasks, not code):

1. **Uber Direct eligibility** for Anthony's region. Create account at
   direct.uber.com; sandbox is immediate, production needs billing on file and
   Uber approval. If ineligible, delivery falls back to flat fee + zip list.
2. **Stripe account** in Anthony's name (or Ryan's on his behalf, his call).
3. **Google Cloud project** with Calendar and Gmail APIs and an OAuth client;
   Anthony authorizes once from the admin page. Two calendars created.
4. **Meta developer app** with Instagram API with Instagram Login; Anthony's
   account is already Business/Creator. One authorization from admin.
5. **Cloudflare account** and DNS move.

Config Anthony supplies:

- Menu: three size names, descriptions, prices.
- Subscription grid: cadences (e.g. weekly, every other week, monthly), which
  size × cadence cells are offered, monthly price per cell.
- Daily cap, cutoff time, open weekdays, studio ready time for courier pickup.
- Studio pickup address and pickup instructions.
- Admin passcode.

## 8. Verification (to complete at ship)

- All unit and route tests green.
- Acceptance walk-through in §4.6 passed on a preview deploy.
- Stripe test-mode order and subscription end to end, including portal.
- Uber sandbox dispatch end to end.
- Instagram feed populated from Anthony's real account.
- Closed calendar event closes a day within 15 minutes.

## 9. Outcome

To be filled at ship: what went live, version, what Anthony noticed.
