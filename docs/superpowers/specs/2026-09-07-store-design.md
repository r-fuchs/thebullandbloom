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
   Nightly materialization of subscriber bouquets for the calendar and courier
   flow; subscriber bouquets do not count against the daily pool (D14).
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
| D15 | A `done` order still consumes its day's capacity; only `cancelled`/`refunded` free a slot | Count held+paid only | Found in the Plan 1 final review (2026-09-07): with held+paid only, ticking "done" at 9 am on a full day reopened same-day sales before the 11:00 cutoff. |
| D16 | The Stripe Checkout session expires one minute after the 30-minute hold target, and the database hold is released two minutes after the session expires | Same instant for both | Stripe enforces a 30-minute minimum measured on receipt, so an exact 30 minutes computed before the request can be rejected; and a payment completed seconds before expiry must not find its order already cancelled by the sweep. |
| D17 | A `checkout.session.completed` webhook for a session whose order was already cancelled by the sweep resurrects the order as paid | Ignore it | A paid-but-cancelled order is a customer charged with no bouquet; being briefly over cap is the lesser harm and is visible in admin. |
| D14 | Subscriber bouquets do not count against the daily cap | Count them ahead of one-time orders | Ryan's call (2026-09-07). The cap is Anthony's one-time-order budget; subscriptions are planned work he sizes separately. Admin shows the subscriber count per day next to the cap so he can see the whole load. |
| D18 | The Google refresh token lives in D1 `settings` under key `google.token`, AES-GCM encrypted with a key derived from `ADMIN_SECRET`. | Wrangler secret; plaintext in D1 | A Worker cannot write Wrangler secrets at runtime, so a secret would force Ryan to copy a token by hand after Anthony's one-click connect. Encryption means a D1 dump alone cannot send mail as Anthony. Rotating `ADMIN_SECRET` requires reconnecting Google (visible in admin as "not connected"). |
| D19 | The two calendars are created by the store when Anthony connects: find by name in his calendar list, else create. Ids are stored in `settings` key `google.state`. | Anthony creates them by hand; ids pasted into config | Removes two manual steps and a config edit (spec §1's test). Renaming a calendar in Google does not break anything because the id is what is stored. |
| D20 | Order side effects (calendar event, customer email, owner email) go through an `outbox` table. Rows are inserted in the same D1 batch as the `paid` flip, drained immediately in the background, then by the 15-minute cron with exponential backoff (2, 4, 8 … 64 min, capped) up to 24 attempts (~22 h), after which the row is "failed" and admin shows it with a Retry button. | Fire-and-forget from the webhook; a separate queue product | Spec §4.5 requires queue-and-retry for both Google dependencies. A table is the only queue that costs nothing and is visible in admin. Same-batch insert means a paid order can never exist without its three delivery rows. |
| D21 | The Orders-calendar event id is derived from the order id (`bb` + the UUID without hyphens), and a 409 from Google on insert counts as success. | Let Google assign ids | A retry after a timeout cannot create a duplicate event. |
| D22 | The OAuth consent screen is published "In production" without Google verification. Anthony sees Google's "unverified app" interstitial once and clicks through. | "Testing" status | Testing-status refresh tokens expire after 7 days, which would silently stop calendar and email weekly. Verification is a multi-day review that can be filed later if the interstitial proves unacceptable. Task 12 checks this on the real consent flow. |
| D23 | Anthony's copy of each order goes to `store.config.json` `studio.ownerEmail`, defaulting to the store Gmail itself. | Separate notification address | Gmail delivers self-sent mail normally, and the store account is the one he authorized. Changing it is a config edit. |
| D24 | Order events are all-day events on the order date with size, name, and fulfillment in the title. | Timed event at a ready time | The phone's day view lists all-day items at the top as a checklist. A studio ready time does not exist in config until Plan 3 (courier pickup). |
| D25 | The OAuth callback is authenticated by a signed, 10-minute `state` parameter (HMAC with a key derived from `ADMIN_SECRET`), not by the admin cookie. | Cookie only | The admin cookie is `SameSite=Strict`, and a redirect back from accounts.google.com is a cross-site top-level navigation, so the browser withholds the cookie. |

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
  weekdays, hold duration (30 min; see D16 for the padding around it), Instagram poll interval, fallback flat
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

Capacity for a date = cap(date) − count(orders where date and source =
`one_time` and status in `held`,`paid`,`done`) where cap(date) is the override
if present else the default, and 0 if the day is closed or not an open weekday.
Subscription-sourced orders are excluded (D14) but are shown per day in admin.
Only `cancelled` and `refunded` free a slot; marking an order done is
bookkeeping, not capacity (D15).

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
admin flag). Materialized orders do not consume capacity (D14); they exist so
the order appears on the calendar, in admin, and in the courier flow.

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
HttpOnly cookie valid 30 days. Rate limiting is a Cloudflare rule on the login
and checkout endpoints, configured at deploy, not application code. The
passcode must be high-entropy (a generated 20+ character string). No user
accounts.

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
| `core/capacity` | remaining(date) over one-time orders only, isOrderable(date, now), applyOverrides | nothing |
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

## 8. Verification

Plan 1 (core store), verified 2026-09-08 on the preview deployment:

- 75 unit and route tests green in workerd against a throwaway D1; typecheck clean.
- Whole-branch review (Opus) plus one fix wave; all Critical/Important findings closed, minors recorded in the plan.
- Deployed to https://thebullandbloom.thebullandbloom.workers.dev on Ryan's Cloudflare account; D1 `bullandbloom` migrated; cron live.
- Live checks: home page with menu and order form, admin page, config and availability APIs, admin login/logout/401, closing a day propagates to the public picker, reopening restores it.
- Stripe sandbox (Anthony's account) end to end: checkout created a session, a test-card payment completed, the webhook flipped the order to `paid` with the payment intent recorded and the hold cleared. A checkout against a bad key returned 503 and released its hold.
- Same-day cutoff observed live: at 18:25 Eastern the current day was open but not orderable.

Still to verify in later plans: Uber sandbox dispatch, Instagram feed, Closed-calendar sync, subscription portal, and the Cloudflare rate-limit rules (need the zone, so at DNS cutover).

## 9. Outcome

Plan 1 shipped to a preview URL on 2026-09-08 (branch `feat/store`, not merged; merge is the cutover because the page moved into `site/`). What Anthony would notice: a menu with three sizes and a day picker on his site, Stripe taking payment, and an admin page where closing a day takes it off the market instantly. Prices, cap, cutoff, and studio address are SAMPLE values until he supplies his (§7). Plan 2 (Google calendar and email) is next so he learns of orders without opening admin.
