# Store Plan 7 — Current offers: Wreath & Sip

**Date:** 2026-10-02
**Status:** approved in conversation, awaiting Ryan's read of this document
**Owner:** Ryan Fuchs (build); Anthony Demonia (product owner, operator)
**Builds on:** `2026-09-07-store-design.md` (Plans 1–4), `2026-09-15-store-plan-5-vase-tax-zones-design.md`
(Plan 5), and Plan 6 (admin sign-in through Cloudflare Access).

## 1. Why

Anthony wants to teach an autumn wreath-making evening at the studio, a few dates with a
handful of seats each, sold as "Wreath & Sip". The store today sells bouquets by the day;
it has no idea of an event with fixed sessions and a seat count. This plan adds a small,
general "offers" feature so this class, and whatever comes after it, can be sold from the
site with seats enforced, paid through Stripe, and switched off when the run is over.
The first offer is Wreath & Sip; nothing in the build is specific to wreaths.

## 2. Decisions (all made 2026-10-02 with Ryan)

- **D46 A seat is paid in full online through Stripe Checkout.** No request form, no
  deposit. The seat is held while the customer pays, exactly like a bouquet order, so a
  seat count is never oversold and a no-show has already paid.
- **D47 Offers and their sessions live in `store.config.json`.** Adding a date, changing
  seats or price, or retiring the offer is a config edit and a deploy. No admin editor in
  this plan. The direction after this plan is offers created in Stripe (§7); the config
  shape is chosen so that swap is a change of source, not of the feature.
- **D48 One seat per booking.** A pair books twice. The form has no quantity.
- **D49 The landing page owns the booking; the homepage carries a teaser.** The booking
  form exists in one place, `/offers/<slug>`, which is also the address to advertise. The
  homepage's "Current offers" section is a card pointing there. Two switches per offer:
  `enabled` (bookable at all) and `showOnHome` (teaser on the homepage). The teaser also
  hides itself when nothing is bookable.
- **D50 Copy names the home studio and promises refreshments, nothing more specific.**
  The name is "Wreath & Sip"; the page describes the evening, the materials and the
  wreath you take home, and says "Refreshments will be provided." It never names a drink
  or asks anyone to bring anything, on the page, in the email or in an ad. The page says
  "Hosted at Anthony's home studio in Albany. The address comes with your
  confirmation."; the street address appears only in the confirmation email.
- **D51 Meta Pixel on the landing page and the thanks page only,** loaded only when
  `marketing.metaPixelId` is set. The homepage and the order flow stay tracker-free. The
  privacy page's "no advertising trackers" sentence is replaced (§3.9).
- **D52 No calendar event per booking.** The sessions are known dates; what Anthony
  needs is the headcount, which the admin page and his per-booking email carry.
- **D53 Refunds happen in Stripe; admin "cancel" frees the seat.** Booking status is
  `held`, `paid` or `cancelled`. A cancelled booking no longer counts against seats.
- **D54 Bookings close a fixed number of hours before the session starts,** set per offer
  (`bookingClosesHoursBefore`, default 24) so Anthony can buy materials.
- **D55 A booking is a party, not a seat** (added 2026-10-02, after launch). Classes sell in
  twos and threes, and the one-seat form made a friend repeat the whole checkout. `bookings.seats`
  (default 1, at most 6 per booking) says how many the party holds; seats taken is `SUM(seats)`;
  the guarded insert fits the whole party or none and `sold_out` carries `remaining` so the page
  can offer a smaller party. `price_cents` stays per seat; Stripe gets the quantity; the emails
  and admin count seats, not rows. Admin cancel frees the whole party (a partial refund is a
  Stripe matter, as in D53). The landing page also gained a top call to action, what's included,
  Anthony's portrait and a line about him, a 48-hour move-or-refund cancellation line, and an
  Instagram link for proof: the conversion pass before paid traffic.

## 3. What changes

### 3.1 Config

`store.config.json` gains two keys. Example with the first offer:

```json
"marketing": { "metaPixelId": "" },
"offers": [
  {
    "id": "wreath-and-sip-autumn-2026",
    "slug": "wreath-and-sip",
    "enabled": true,
    "showOnHome": true,
    "name": "Wreath & Sip",
    "tagline": "Make an autumn wreath at the studio",
    "description": "An evening at the studio …",
    "image": "assets/wreath.jpg",
    "imageAlt": "Autumn wreath of …",
    "priceCents": 8500,
    "durationMinutes": 120,
    "bookingClosesHoursBefore": 24,
    "sessions": [
      { "id": "2026-11-07-1800", "date": "2026-11-07", "start": "18:00", "seats": 8 }
    ]
  }
]
```

The price, dates, seats and copy above are placeholders; the real values are blanks in §6.

`validateConfig` checks: offer ids and slugs unique and URL-safe (`[a-z0-9-]+`); session
ids unique within an offer; `date` is `YYYY-MM-DD`; `start` is `HH:MM`; `seats` and
`priceCents` positive integers (Stripe refuses a zero amount); `durationMinutes` and
`bookingClosesHoursBefore` non-negative integers; `image` a path under `assets/`. A
missing `offers` key means no offers; a missing `marketing` key means no pixel. A bad
config fails the config test and the Worker's boot, as it does today.

The fields are a one-to-one match for a Stripe Product (`name`, `description`, `images`,
`metadata.slug`) plus a Price (`unit_amount`), which is what §7 relies on.

### 3.2 Landing page: `/offers/<slug>`

One static page, `site/offers/index.html` with `site/offers/offer.js`, serves every
offer. The Worker gets a route `GET /offers/:slug` that returns that asset (through the
`ASSETS` binding) so the address is clean for an ad; the script reads the slug from the
URL and picks the offer from `GET /api/offers`.

The page shows the photo, the name and tagline, the description, the price per seat, the
length, "Refreshments will be provided.", the home-studio line from D50, a row of session
buttons ("Sat Nov 7 · 6 pm · 3 seats
left"; full ones read "Sold out" and are disabled; a closed one reads "Closed"), and the
form: name, email, phone (optional), note (optional), "Reserve my seat". Submitting posts
to `/api/book` and follows the Stripe URL, with the same status line and error texts the
order form uses (`sold_out` says "That date just filled up — pick another."). The
total line ends "· tax added at checkout".

An unknown slug, or an offer with `enabled: false`, renders the page with the title
"Not currently offered" and a line inviting an email to Anthony. An enabled offer whose
sessions are all past or full renders normally with "No open dates right now" in place
of the form. Neither is a 404: an ad link never dead-ends.

Styling copies the palette, fonts, button and form rules from the homepage into a small
`site/offers/offer.css`, the way `thanks.html` carries its own styles. Pulling a shared
stylesheet out of `index.html` is out of scope.

### 3.3 Homepage teaser and nav

`site/index.html` gains `<section id="offers" hidden>` above `#order` (Ryan, 2026-10-02: the offer leads the page; the store heading becomes "Order a bouquet"),
headed "Current offers", and a nav link "Offers" that is also hidden by default.
`store.js` fetches `/api/offers` and, for each offer with `showOnHome` true and at least
one bookable session, renders a card: the photo, the name, the tagline, "Next: Sat Nov 7
· 6 pm · 3 seats left", and a "Book a seat" link to `/offers/<slug>`. If any card
renders, the section and the nav link are shown. If the fetch fails the section stays
hidden; the order form is unaffected.

### 3.4 Thanks page

`site/thanks.html` gains a third variant for `?booking=<id>&offer=<offerId>`: "Your seat
is saved. The details, including where to come, are in the email on its way to you."
The success URL from `/api/book` carries both query values.

### 3.5 Data model

Migration `0008_bookings.sql`:

```sql
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','paid','cancelled')),
  offer_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  note TEXT,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  price_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  hold_expires_at INTEGER
);
CREATE INDEX bookings_session ON bookings (offer_id, session_id, status);
CREATE INDEX bookings_hold ON bookings (status, hold_expires_at);
```

Seats taken for a session = count of bookings for that offer and session with status
`held` or `paid`. Seats remaining = `seats` − taken, floored at 0. A session is
**bookable** when the offer is enabled, the session's start (date + start in the studio
timezone) is more than `bookingClosesHoursBefore` hours away, and seats remain.

`src/core/offers.ts` holds the pure parts: `sessionStart(session, tz)`,
`seatsRemaining(seats, taken)`, `isBookable(offer, session, taken, clock)`, and
`nextBookable(offer, takenBySession, clock)` for the teaser. `src/store/bookings.ts`
mirrors `store/orders.ts`: `countTaken(db, offerId)` grouped by session,
`tryInsertHeldBooking` (an `INSERT … SELECT … WHERE taken < seats`, the same guard
`tryInsertHeldOrder` uses), `attachSession`, `markPaidBySession` with the outbox
statements batched in, `cancelHeldBySession`, `cancelBooking` (held or paid → cancelled),
`expireHolds`, `listForOffer`.

### 3.6 Public API

- `GET /api/offers` → `{ offers: [...], marketing: { metaPixelId } }`. Only enabled
  offers; only sessions on or after today; each session carries `remaining` and
  `bookable`. Nothing about who booked.
- `POST /api/book { offerId, sessionId, customer: { name, email, phone? }, note? }`.
  Validation as `/api/checkout` (`parseCheckout`'s customer rules reused). Errors: 400 on
  a bad body or unknown offer or session; 409 `disabled` if the offer is off; 409 `closed`
  past the cutoff; 409 `sold_out` when the guarded insert does not land; 503
  `payments_unavailable` when Stripe fails, after cancelling the held row. On success it
  creates the Checkout Session with one line item (`"Wreath & Sip — Sat Nov 7, 6 pm"`,
  the seat price, quantity 1, tax category `workshop`), tax address the studio, the same
  hold padding as orders (D16), success URL `/thanks?booking=<id>&offer=<offerId>`,
  cancel URL `/offers/<slug>`, and returns `{ url }`.

`workshop` is a new `TaxCategory` in `adapters/payments.ts`. The customer leaves with a
wreath, so it maps to Stripe's general tangible goods code (`txcd_99999999`) unless Ryan
picks a different code in §6.

### 3.7 Webhook and emails

`checkout.session.completed`: the handler tries `orders.markPaidBySession` first and, when
that returns null, `bookings.markPaidBySession`. `checkout.session.expired` likewise
cancels a held order, then a held booking. Both stay idempotent on the session id.

Two new outbox kinds, `booking_confirmed_customer` and `booking_confirmed_owner`, are
queued in the same batch that marks the booking paid (the `order_id` column carries the
booking id, as it carries a subscriber id today). The drain job loads the booking and
the offer and sends through the Google adapter:

- Customer: subject "Your seat at Wreath & Sip"; the date, start time and length; the
  studio's street address with a line that it is Anthony's home studio; what to expect,
  that all materials are provided and that refreshments will be provided (the same words
  as the page, D50); the cancellation terms from §6; Anthony's phone and email for
  questions.
- Anthony: "Jane Doe booked Wreath & Sip, Sat Nov 7 — 5 of 8 seats"; the customer's
  email, phone and note.

When Google is not connected the rows wait and retry, as order emails do.

The scheduled job that expires order holds also calls `bookings.expireHolds`.

### 3.8 Admin

`GET /admin/api/offers` returns every offer in config (enabled or not) with each session
from the last 30 days onward: seats, paid count, held count, and the bookings (id, name,
email, phone, note, status, created time). `POST /admin/api/bookings/:id/cancel` sets a
held or paid booking to `cancelled` (D53) and returns 404 otherwise.

`site/admin/index.html` gains a "Classes" panel under Subscribers: one block per offer,
a line per session ("Sat Nov 7, 6 pm — 5 of 8 seats"), the names and emails under it,
and a "Cancel" button per booking with a confirm step that reminds Anthony to refund in
Stripe first. Offers with no upcoming sessions collapse to a single line.

### 3.9 Pixel and privacy

When `metaPixelId` is non-empty, `offer.js` injects the standard Meta Pixel snippet and
fires `PageView`; `thanks.html` injects it and fires `Purchase` with `value` = the seat
price in dollars and `currency: "USD"` when `?booking=` is present and the offer is
found in `/api/offers`. No pixel anywhere else; an empty id injects nothing.

`site/privacy.html`: "What we don't do" loses "There are no advertising trackers on this
site" and gains a sentence: the class pages and the thank-you page use the Meta Pixel
so we can measure ads we run on Facebook and Instagram; the rest of the site does not,
and Meta's own policy covers what it collects. "Last updated" moves to the deploy date.

## 4. Failure modes

| Situation | Behavior |
|---|---|
| Stripe fails on `/api/book` | held row cancelled, 503 `payments_unavailable`, page says "Payments are down, try again in a minute." |
| Seat taken between page load and submit | guarded insert fails, 409 `sold_out`, page reloads sessions and says so |
| Offer disabled by a deploy while the page is open | 409 `disabled`, page re-renders as not currently offered |
| Customer abandons Stripe | Stripe expiry webhook cancels the hold; the nightly expiry is the safety net |
| Google not connected | confirmation emails wait in the outbox and retry; the seat is still paid |
| Pixel blocked by the browser | nothing; booking works regardless |
| `/api/offers` fails on the homepage | teaser stays hidden; the order form is unaffected |
| Bad offer config | `validateConfig` throws; the config test fails before deploy |

## 5. Testing

- `tests/core/offers.test.ts`: `sessionStart` across the DST change; `seatsRemaining`;
  `isBookable` at the cutoff edge, when full, when disabled, when past; `nextBookable`
  picks the earliest bookable session.
- `tests/config.test.ts`: duplicate session id, bad date, bad start, zero seats, bad slug
  each rejected; a config without `offers` or `marketing` accepted.
- `tests/routes/offers.test.ts` (workerd, throwaway D1): `/api/offers` hides disabled
  offers and past sessions and counts held plus paid; `/api/book` happy path lands a held
  row and a session; `sold_out` on the last seat under two concurrent posts; `closed` at
  the cutoff; `disabled`; Stripe failure cancels the hold; the webhook marks paid and
  queues both emails; expiry frees the seat; `/offers/<slug>` serves the page for any
  slug.
- `tests/routes/admin.test.ts` additions: `/admin/api/offers` shape; cancel frees the
  seat; cancel on a cancelled booking is 404.
- `tests/jobs/outbox.test.ts` additions: both booking kinds render the expected subject
  and body through the Google fake.
- `tests/smoke.test.ts`: the homepage teaser section is present and hidden by default;
  the landing page and thanks page parse.

## 6. Blanks to fill before the build steps that need them

| Blank | Needed by | Default if unanswered |
|---|---|---|
| Seat price | config (3.1) | none; the build uses a placeholder and the deploy waits |
| Seats per session | config | 8 |
| Dates and start times | config | one sample session, replaced before deploy |
| Length of the class | config | 120 minutes |
| Booking cutoff | config | 24 hours |
| The wreath photo as `site/assets/wreath.jpg` and its alt text | landing page, teaser | none; the build ships without the image until it lands |
| Description copy | landing page | a draft Ryan or Anthony edits |
| Customer email wording, including cancellation terms | outbox (3.7) | a draft with no refund promise either way |
| Stripe tax code for the seat | payments (3.6) | `txcd_99999999` general tangible goods |
| Meta Pixel id | config | empty; no pixel loads |

## 7. Direction: offers created in Stripe

The next step, when Anthony wants to publish offers without a deploy, is to read active
Stripe Products carrying `metadata.offer = "1"` in place of `config.offers`: name,
description, images and `metadata.slug` from the Product, the seat price from its default
Price. Sessions would live in Product metadata (`sessions` as JSON) or in a small admin
table keyed by product id. Seat counting, the booking flow, the pages and the admin
panel keep working against the same `Offer` shape; only the source changes. Stripe keeps
no inventory, so seats stay in D1 either way.

## 8. Anthony's class night (acceptance narrative)

Ryan adds the offer to config with three November dates and deploys. The homepage shows
"Current offers" with the wreath, and the Facebook ad points at
`thebullandbloom.com/offers/wreath-and-sip`. Jane books a seat for the 7th, pays on
Stripe, and gets an email with the time, the address and what to expect; Anthony gets
"Jane Doe booked Wreath & Sip, Sat Nov 7 — 5 of 8 seats". The eighth seat sells on the
5th and the button reads "Sold out". On the 6th at 6 pm bookings for the 7th close. One
guest emails to say she can't make it; Anthony refunds her in Stripe, opens admin, and
cancels her booking, and the date shows 7 of 8 again. After the last date Ryan flips
`showOnHome` to false while the ad finishes, then `enabled` to false, and the landing
page says the class is not currently offered.
