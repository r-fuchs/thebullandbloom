# Store Plan 7 — Current offers: Wreath & Sip: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell seats at a class ("Wreath & Sip") from the site: a landing page per offer at `/offers/<slug>`, a homepage teaser, seats held and paid through Stripe Checkout exactly like bouquets, confirmation emails through the outbox, a Classes panel in admin, and a Meta Pixel on the class and thank-you pages only.

**Architecture:** Offers and their sessions are config (`store.config.json`), validated at boot. A new `bookings` table mirrors `orders` (held → paid → cancelled, guarded insert against the seat count, hold expiry). Pure seat and cutoff logic lives in `src/core/offers.ts`; D1 access in `src/store/bookings.ts`; public routes in `src/routes/offers.ts`; admin routes in `src/routes/admin-offers.ts`. The Stripe webhook tries orders first, then bookings, on the same session id. Two new outbox kinds carry the booking emails. The landing page is one static page that reads the slug from the URL; the Worker serves it at `/offers/:slug` through the `ASSETS` binding.

**Tech Stack:** Cloudflare Worker (Hono, D1), Stripe Node SDK v22, vitest with `@cloudflare/vitest-pool-workers` (migrations in `migrations/` are applied to the test D1 automatically), ES5 storefront with no build step.

**Spec:** `docs/superpowers/specs/2026-10-02-store-plan-7-offers-design.md`

## Global Constraints

- Storefront JS (`site/store.js`, `site/offers/offer.js`, `site/thanks.html`, `site/admin/index.html`) is ES5: `var`, `function`, no arrow functions, no template literals, no `const`.
- Run all tests with `npx vitest run` (from the repo root; each test file shares one D1). Typecheck with `npx tsc --noEmit`. Both must be clean before every commit.
- Commit messages: conventional `type(scope): summary`, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Prices are integers in cents. The seat price in the repo config is a placeholder (`8500`) until Ryan fills §6 of the spec; the committed offer ships with `"enabled": false` and `"showOnHome": false` so a deploy sells nothing at the placeholder price. Task 11 flips them.
- Copy rules (D50): the words "Refreshments will be provided." appear verbatim on the landing page and in the customer email. No drink is named anywhere. The street address appears only in the confirmation email; the page and the teaser say "Hosted at Anthony's home studio in Albany. The address comes with your confirmation."
- Tax: the seat line carries the new `workshop` category, code `txcd_99999999`, tax behavior `exclusive`, tax address the studio.
- Holds: the same D16 padding as orders. Stripe `expires_at` = now + `holdMinutes`·60 + 60; `hold_expires_at` = that + 120.
- Pixel: injected only by `site/offers/offer.js` and `site/thanks.html`, only when `marketing.metaPixelId` is non-empty. Never on the homepage.
- Tests read the real repo config through `loadConfig()` for everything that is not an offer. Offer tests use the `WREATH` fixture from `tests/helpers.ts` through `offersConfig()`, never the repo's offer values (they will change when Ryan fills the blanks).
- Tests that insert bookings run `DELETE FROM bookings` (and `DELETE FROM outbox` where the outbox is involved) in `beforeEach`; the D1 persists across `it()` blocks in a file.
- Working in a worktree: `node_modules` is not there. Run `ln -s "$(git rev-parse --show-toplevel | sed 's#/.worktrees/.*##')/node_modules" node_modules` if the main checkout is the parent, otherwise `npm ci`.
- Branching: the integration branch is `claude/staging-review-bull-bloom-f8x3sw`. Each task works on `plan7/task-N` and is merged into the integration branch when its review passes, as Plan 5 did.

## Task map and parallelism

| Task | Touches | Depends on |
|---|---|---|
| 1 Config: offers and marketing | `src/config.ts`, `store.config.json`, `tests/config.test.ts` | — |
| 2 Core seat and cutoff logic | `src/core/offers.ts`, `tests/core/offers.test.ts` | 1 |
| 3 Bookings table and store, outbox kinds | `migrations/0008_bookings.sql`, `src/store/bookings.ts`, `src/store/outbox.ts`, `tests/store/bookings.test.ts` | 1 |
| 4 Public API: `/api/offers`, `/api/book`, `workshop` tax | `src/adapters/payments.ts`, `src/adapters/stripe.ts`, `src/routes/public.ts`, `src/routes/offers.ts`, `src/app.ts`, `tests/helpers.ts`, `tests/routes/offers.test.ts`, `tests/adapters/stripe.test.ts` | 2, 3 |
| 5 Booking emails and outbox delivery | `src/core/booking-messages.ts`, `src/jobs/outbox.ts`, `tests/core/booking-messages.test.ts`, `tests/jobs/outbox.test.ts` | 3, 4 (helpers) |
| 6 Webhook and scheduled expiry | `src/routes/webhooks.ts`, `src/scheduled.ts`, `tests/routes/webhooks.test.ts`, `tests/scheduled.test.ts` | 5 |
| 7 Admin API and Classes panel | `src/routes/admin-offers.ts`, `src/routes/admin.ts`, `site/admin/index.html`, `tests/routes/admin-offers.test.ts` | 4 |
| 8 Landing page and `/offers/:slug` | `site/offers/index.html`, `site/offers/offer.css`, `site/offers/offer.js`, `src/routes/offers.ts`, `tests/smoke.test.ts`, `tests/routes/offers.test.ts` | 4 |
| 9 Homepage teaser and nav | `site/index.html`, `site/store.js`, `tests/smoke.test.ts` | 4 |
| 10 Thanks page, privacy, README | `site/thanks.html`, `site/privacy.html`, `README.md`, `tests/smoke.test.ts` | 4 |
| 11 Fill the blanks and verify live (lead) | `store.config.json`, `site/assets/wreath.jpg` | all |

Tasks 1 → 2 and 3 (parallel) → 4 → 5 → 6 form the spine. Tasks 7, 8, 9 and 10 can run in parallel once 4 is merged; 8, 9 and 10 all add tests to `tests/smoke.test.ts` (append-only, distinct `it` blocks; rebase and keep both sides on conflict).

---

### Task 1: Config: `offers` and `marketing` keys with validation

**Files:**
- Modify: `src/config.ts`
- Modify: `store.config.json`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces, in `src/config.ts`:
  ```ts
  export interface OfferSession { id: string; date: string; start: string; seats: number }
  export interface Offer {
    id: string; slug: string; enabled: boolean; showOnHome: boolean;
    name: string; tagline: string; description: string; image: string; imageAlt: string;
    priceCents: number; durationMinutes: number; bookingClosesHoursBefore: number;
    sessions: OfferSession[];
  }
  export interface Marketing { metaPixelId: string }
  // on StoreConfig:
  offers?: Offer[];
  marketing?: Marketing;
  export function offersOf(cfg: StoreConfig): Offer[]            // cfg.offers ?? []
  export function offerById(cfg: StoreConfig, id: string): Offer | undefined
  export function offerBySlug(cfg: StoreConfig, slug: string): Offer | undefined
  ```
- `validateConfig` fills `bookingClosesHoursBefore` with `24` when the key is absent, so every consumer can read it as a number.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`, inside the top-level `describe("config", …)` block, before its closing `});`:

```ts
  it("loads offers and marketing from the repo config", () => {
    const cfg = loadConfig();
    expect(Array.isArray(cfg.offers)).toBe(true);
    expect(cfg.offers!.length).toBeGreaterThan(0);
    const o = cfg.offers![0];
    expect(o.slug).toMatch(/^[a-z0-9-]+$/);
    expect(o.sessions.length).toBeGreaterThan(0);
    expect(offerBySlug(cfg, o.slug)?.id).toBe(o.id);
    expect(offerById(cfg, o.id)?.slug).toBe(o.slug);
    expect(offerById(cfg, "nope")).toBeUndefined();
    expect(typeof cfg.marketing?.metaPixelId).toBe("string");
  });
  it("accepts a config with no offers and no marketing key", () => {
    const { offers: _o, marketing: _m, ...rest } = loadConfig();
    const cfg = validateConfig(rest as any);
    expect(offersOf(cfg)).toEqual([]);
    expect(cfg.marketing).toBeUndefined();
  });
  it("fills bookingClosesHoursBefore with 24 when absent", () => {
    const base = loadConfig();
    const { bookingClosesHoursBefore: _b, ...offer } = base.offers![0];
    const cfg = validateConfig({ ...base, offers: [offer as any] });
    expect(cfg.offers![0].bookingClosesHoursBefore).toBe(24);
  });
  it("rejects a bad offer", () => {
    const base = loadConfig();
    const good = base.offers![0];
    const withOffer = (over: Record<string, unknown>) => ({ ...base, offers: [{ ...good, ...over }] });
    expect(() => validateConfig(withOffer({ slug: "Wreath & Sip" }))).toThrow(/slug/);
    expect(() => validateConfig(withOffer({ id: "Wreath Sip" }))).toThrow(/offer id/);
    expect(() => validateConfig({ ...base, offers: [good, good] })).toThrow(/duplicate offer/);
    expect(() => validateConfig({ ...base, offers: [good, { ...good, id: "other" }] })).toThrow(/duplicate offer slug/);
    expect(() => validateConfig(withOffer({ priceCents: 0 }))).toThrow(/priceCents/);
    expect(() => validateConfig(withOffer({ durationMinutes: -1 }))).toThrow(/durationMinutes/);
    expect(() => validateConfig(withOffer({ bookingClosesHoursBefore: 1.5 }))).toThrow(/bookingClosesHoursBefore/);
    expect(() => validateConfig(withOffer({ image: "/etc/passwd" }))).toThrow(/image/);
    expect(() => validateConfig(withOffer({ name: "" }))).toThrow(/name/);
    expect(() => validateConfig(withOffer({ enabled: "yes" }))).toThrow(/enabled/);
    expect(() => validateConfig({ ...base, offers: "nope" as any })).toThrow(/offers must be an array/);
  });
  it("rejects a bad session", () => {
    const base = loadConfig();
    const good = base.offers![0];
    const s = good.sessions[0];
    const withSessions = (sessions: unknown[]) => ({ ...base, offers: [{ ...good, sessions: sessions as any }] });
    expect(() => validateConfig(withSessions([s, s]))).toThrow(/duplicate session id/);
    expect(() => validateConfig(withSessions([{ ...s, date: "2026-13-01" }]))).toThrow(/date/);
    expect(() => validateConfig(withSessions([{ ...s, start: "6pm" }]))).toThrow(/start/);
    expect(() => validateConfig(withSessions([{ ...s, seats: 0 }]))).toThrow(/seats/);
    expect(() => validateConfig(withSessions([{ ...s, id: "" }]))).toThrow(/session id/);
    expect(() => validateConfig(withSessions("nope" as any))).toThrow(/sessions must be an array/);
  });
  it("rejects a non-numeric pixel id and accepts an empty one", () => {
    const base = loadConfig();
    expect(validateConfig({ ...base, marketing: { metaPixelId: "" } }).marketing?.metaPixelId).toBe("");
    expect(validateConfig({ ...base, marketing: { metaPixelId: "1234567890" } }).marketing?.metaPixelId).toBe("1234567890");
    expect(() => validateConfig({ ...base, marketing: { metaPixelId: "abc" } })).toThrow(/metaPixelId/);
    expect(() => validateConfig({ ...base, marketing: {} as any })).toThrow(/metaPixelId/);
  });
```

Change the import line at the top of the file to:

```ts
import { loadConfig, offerById, offerBySlug, offersOf, sizeById, subscriptionCell, validateConfig } from "../src/config";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: the new tests fail (`offerBySlug` is not exported; `cfg.offers` is undefined).

- [ ] **Step 3: Add the types, validation and lookups**

In `src/config.ts`, add after the `DeliveryZone` interface:

```ts
/** One sitting of a class (Plan 7). `date` is YYYY-MM-DD and `start` is HH:MM in the studio timezone. */
export interface OfferSession { id: string; date: string; start: string; seats: number }
/**
 * A bookable class or event sold by the seat (Plan 7, D47). `enabled` makes it bookable at all;
 * `showOnHome` puts the teaser card on the homepage (D49). The fields map one-to-one onto a Stripe
 * Product plus Price, so a later source swap (spec §7) keeps this shape.
 */
export interface Offer {
  id: string; slug: string; enabled: boolean; showOnHome: boolean;
  name: string; tagline: string; description: string; image: string; imageAlt: string;
  priceCents: number; durationMinutes: number;
  /** bookings close this many hours before a session starts (D54); 24 when absent */
  bookingClosesHoursBefore: number;
  sessions: OfferSession[];
}
/** Meta Pixel id for the class pages and the thank-you page only (D51); empty = no pixel. */
export interface Marketing { metaPixelId: string }
```

Add to the `StoreConfig` interface, after `holdMinutes: number;`:

```ts
  /** Plan 7. Absent = no offers. */
  offers?: Offer[];
  /** Plan 7. Absent = no pixel. */
  marketing?: Marketing;
```

Add after the `E164` constant:

```ts
const SLUG = /^[a-z0-9-]+$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ASSET = /^assets\/[A-Za-z0-9._-]+$/;

function ymdValid(s: unknown): boolean {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.toISOString().slice(0, 10) === s;
}

function validateOffers(offers: unknown): void {
  if (offers === undefined) return;
  if (!Array.isArray(offers)) throw new Error("config: offers must be an array");
  const ids = new Set<string>(), slugs = new Set<string>();
  for (const o of offers as Offer[]) {
    if (typeof o?.id !== "string" || !SLUG.test(o.id)) throw new Error("config: every offer id must match [a-z0-9-]+");
    if (ids.has(o.id)) throw new Error(`config: duplicate offer id ${o.id}`);
    ids.add(o.id);
    if (typeof o.slug !== "string" || !SLUG.test(o.slug)) throw new Error(`config: offer ${o.id} slug must match [a-z0-9-]+`);
    if (slugs.has(o.slug)) throw new Error(`config: duplicate offer slug ${o.slug}`);
    slugs.add(o.slug);
    if (typeof o.enabled !== "boolean") throw new Error(`config: offer ${o.id} enabled must be true or false`);
    if (typeof o.showOnHome !== "boolean") throw new Error(`config: offer ${o.id} showOnHome must be true or false`);
    if (typeof o.name !== "string" || o.name.trim() === "") throw new Error(`config: offer ${o.id} name required`);
    for (const k of ["tagline", "description", "imageAlt"] as const) {
      if (typeof o[k] !== "string") throw new Error(`config: offer ${o.id} ${k} must be a string`);
    }
    if (typeof o.image !== "string" || !ASSET.test(o.image)) throw new Error(`config: offer ${o.id} image must be a path under assets/`);
    if (!Number.isInteger(o.priceCents) || o.priceCents <= 0) throw new Error(`config: offer ${o.id} priceCents must be a positive integer`);
    if (!Number.isInteger(o.durationMinutes) || o.durationMinutes < 0) throw new Error(`config: offer ${o.id} durationMinutes must be a non-negative integer`);
    if (o.bookingClosesHoursBefore === undefined) o.bookingClosesHoursBefore = 24;
    if (!Number.isInteger(o.bookingClosesHoursBefore) || o.bookingClosesHoursBefore < 0) throw new Error(`config: offer ${o.id} bookingClosesHoursBefore must be a non-negative integer`);
    if (!Array.isArray(o.sessions)) throw new Error(`config: offer ${o.id} sessions must be an array`);
    const sids = new Set<string>();
    for (const s of o.sessions) {
      if (typeof s?.id !== "string" || s.id.trim() === "") throw new Error(`config: offer ${o.id} has a session with no session id`);
      if (sids.has(s.id)) throw new Error(`config: offer ${o.id} duplicate session id ${s.id}`);
      sids.add(s.id);
      if (!ymdValid(s.date)) throw new Error(`config: offer ${o.id} session ${s.id} date must be YYYY-MM-DD`);
      if (!HM.test(s.start ?? "")) throw new Error(`config: offer ${o.id} session ${s.id} start must be HH:MM`);
      if (!Number.isInteger(s.seats) || s.seats <= 0) throw new Error(`config: offer ${o.id} session ${s.id} seats must be a positive integer`);
    }
  }
}

function validateMarketing(m: unknown): void {
  if (m === undefined) return;
  const id = (m as Marketing)?.metaPixelId;
  if (typeof id !== "string" || (id !== "" && !/^\d+$/.test(id))) throw new Error("config: marketing.metaPixelId must be a string of digits, or empty");
}
```

In `validateConfig`, immediately before `return cfg;`:

```ts
  validateOffers(cfg.offers);
  validateMarketing(cfg.marketing);
```

Add at the bottom of the file:

```ts
export function offersOf(cfg: StoreConfig): Offer[] {
  return cfg.offers ?? [];
}

export function offerById(cfg: StoreConfig, id: string): Offer | undefined {
  return offersOf(cfg).find((o) => o.id === id);
}

export function offerBySlug(cfg: StoreConfig, slug: string): Offer | undefined {
  return offersOf(cfg).find((o) => o.slug === slug);
}
```

- [ ] **Step 4: Add the keys to the repo config**

In `store.config.json`, after the `"holdMinutes": 30,` line, insert:

```json
  "marketing": { "metaPixelId": "" },
  "offers": [
    {
      "id": "wreath-and-sip-autumn-2026",
      "slug": "wreath-and-sip",
      "enabled": false,
      "showOnHome": false,
      "name": "Wreath & Sip",
      "tagline": "Make an autumn wreath at the studio",
      "description": "An evening at the studio making a full autumn wreath from fresh and dried stems. Anthony walks the room through the base, the shape and the finishing touches; every seat has its own materials, and the wreath goes home with you.",
      "image": "assets/wreath.jpg",
      "imageAlt": "An autumn wreath of dried grasses, seed heads and rust-colored foliage on a wooden door",
      "priceCents": 8500,
      "durationMinutes": 120,
      "bookingClosesHoursBefore": 24,
      "sessions": [
        { "id": "2026-11-07-1800", "date": "2026-11-07", "start": "18:00", "seats": 8 }
      ]
    }
  ],
```

(Keep the JSON valid: the `subscriptions` key that follows keeps its comma structure. `enabled` and `showOnHome` are false on purpose; see Global Constraints and Task 11.)

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/config.test.ts && npx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts store.config.json tests/config.test.ts
git commit -m "feat(config): offers with sessions and seats, marketing pixel id, validated at boot (D47, D51, D54)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Core seat and cutoff logic

**Files:**
- Create: `src/core/offers.ts`
- Test: `tests/core/offers.test.ts`

**Interfaces:**
- Consumes: `Offer`, `OfferSession` from `src/config.ts`; `instantAt`, `humanDate` from `src/core/time.ts`.
- Produces, in `src/core/offers.ts`:
  ```ts
  export interface OfferClock { now: Date; tz: string }
  export function sessionStart(session: OfferSession, tz: string): Date
  export function seatsRemaining(seats: number, taken: number): number
  export function bookingBlocker(offer: Offer, session: OfferSession, clock: OfferClock): "disabled" | "closed" | null
  export function isBookable(offer: Offer, session: OfferSession, taken: number, clock: OfferClock): boolean
  export function nextBookable(offer: Offer, takenBySession: ReadonlyMap<string, number>, clock: OfferClock): OfferSession | null
  export function humanTime(hm: string): string          // "18:00" → "6 pm", "18:30" → "6:30 pm", "12:00" → "12 pm", "00:00" → "12 am"
  export function sessionLabel(session: OfferSession): string   // "Sat Nov 7, 6 pm"
  export function humanDuration(minutes: number): string  // 120 → "2 hours", 60 → "1 hour", 90 → "90 minutes", 0 → ""
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/core/offers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Offer, OfferSession } from "../../src/config";
import { bookingBlocker, humanDuration, humanTime, isBookable, nextBookable, seatsRemaining, sessionLabel, sessionStart } from "../../src/core/offers";

const NY = "America/New_York";
const session = (id: string, date: string, start: string, seats = 8): OfferSession => ({ id, date, start, seats });
const offer = (over: Partial<Offer> = {}): Offer => ({
  id: "wreath", slug: "wreath", enabled: true, showOnHome: true, name: "Wreath & Sip", tagline: "", description: "", image: "assets/wreath.jpg", imageAlt: "",
  priceCents: 8500, durationMinutes: 120, bookingClosesHoursBefore: 24,
  sessions: [session("nov7", "2026-11-07", "18:00")], ...over,
});
const clock = (iso: string) => ({ now: new Date(iso), tz: NY });

describe("sessionStart", () => {
  it("resolves the studio-local start on both sides of the DST change", () => {
    expect(sessionStart(session("a", "2026-10-31", "18:00"), NY).toISOString()).toBe("2026-10-31T22:00:00.000Z"); // EDT
    expect(sessionStart(session("b", "2026-11-07", "18:00"), NY).toISOString()).toBe("2026-11-07T23:00:00.000Z"); // EST
  });
});

describe("seatsRemaining", () => {
  it("subtracts and floors at zero", () => {
    expect(seatsRemaining(8, 0)).toBe(8);
    expect(seatsRemaining(8, 5)).toBe(3);
    expect(seatsRemaining(8, 8)).toBe(0);
    expect(seatsRemaining(8, 9)).toBe(0);
  });
});

describe("bookingBlocker / isBookable", () => {
  const o = offer();
  const s = o.sessions[0]; // starts 2026-11-07T23:00Z; closes 24h before
  it("is bookable more than the cutoff away with seats left", () => {
    expect(bookingBlocker(o, s, clock("2026-11-06T22:59:59Z"))).toBeNull();
    expect(isBookable(o, s, 7, clock("2026-11-06T22:59:59Z"))).toBe(true);
  });
  it("closes exactly at the cutoff and after it", () => {
    expect(bookingBlocker(o, s, clock("2026-11-06T23:00:00Z"))).toBe("closed");
    expect(isBookable(o, s, 0, clock("2026-11-06T23:00:00Z"))).toBe(false);
    expect(bookingBlocker(o, s, clock("2026-11-08T10:00:00Z"))).toBe("closed"); // past
  });
  it("is not bookable when full, but that is not a blocker (the guarded insert decides sold_out)", () => {
    expect(isBookable(o, s, 8, clock("2026-11-01T12:00:00Z"))).toBe(false);
    expect(bookingBlocker(o, s, clock("2026-11-01T12:00:00Z"))).toBeNull();
  });
  it("reports disabled ahead of closed", () => {
    const off = offer({ enabled: false });
    expect(bookingBlocker(off, off.sessions[0], clock("2026-11-01T12:00:00Z"))).toBe("disabled");
    expect(bookingBlocker(off, off.sessions[0], clock("2026-11-08T12:00:00Z"))).toBe("disabled");
    expect(isBookable(off, off.sessions[0], 0, clock("2026-11-01T12:00:00Z"))).toBe(false);
  });
  it("a zero-hour cutoff keeps bookings open until the start", () => {
    const o0 = offer({ bookingClosesHoursBefore: 0 });
    expect(bookingBlocker(o0, o0.sessions[0], clock("2026-11-07T22:59:59Z"))).toBeNull();
    expect(bookingBlocker(o0, o0.sessions[0], clock("2026-11-07T23:00:00Z"))).toBe("closed");
  });
});

describe("nextBookable", () => {
  it("picks the earliest bookable session regardless of config order", () => {
    const o = offer({ sessions: [session("c", "2026-11-21", "18:00"), session("a", "2026-11-07", "18:00", 2), session("b", "2026-11-14", "18:00")] });
    const taken = new Map([["a", 2]]); // a is full
    expect(nextBookable(o, taken, clock("2026-11-01T12:00:00Z"))?.id).toBe("b");
    expect(nextBookable(o, new Map(), clock("2026-11-01T12:00:00Z"))?.id).toBe("a");
    expect(nextBookable(o, new Map(), clock("2026-11-21T12:00:00Z"))).toBeNull(); // all closed
    expect(nextBookable(offer({ enabled: false }), new Map(), clock("2026-11-01T12:00:00Z"))).toBeNull();
  });
});

describe("labels", () => {
  it("formats times, session labels and durations", () => {
    expect(humanTime("18:00")).toBe("6 pm");
    expect(humanTime("18:30")).toBe("6:30 pm");
    expect(humanTime("09:05")).toBe("9:05 am");
    expect(humanTime("12:00")).toBe("12 pm");
    expect(humanTime("00:00")).toBe("12 am");
    expect(sessionLabel(session("x", "2026-11-07", "18:00"))).toBe("Sat Nov 7, 6 pm");
    expect(humanDuration(120)).toBe("2 hours");
    expect(humanDuration(60)).toBe("1 hour");
    expect(humanDuration(90)).toBe("90 minutes");
    expect(humanDuration(0)).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/offers.test.ts`
Expected: FAIL, cannot resolve `../../src/core/offers`.

- [ ] **Step 3: Implement**

Create `src/core/offers.ts`:

```ts
import type { Offer, OfferSession } from "../config";
import { humanDate, instantAt } from "./time";

export interface OfferClock { now: Date; tz: string }

/** The instant a session starts: its date and start time read on the studio clock. */
export function sessionStart(session: OfferSession, tz: string): Date {
  return instantAt(tz, session.date, session.start);
}

export function seatsRemaining(seats: number, taken: number): number {
  return Math.max(0, seats - taken);
}

/**
 * Why a session cannot be booked right now, ignoring seats: the offer is switched off, or the
 * start is not more than `bookingClosesHoursBefore` hours away (D54). Seats are the guarded
 * insert's business (sold_out), so a full session has no blocker here.
 */
export function bookingBlocker(offer: Offer, session: OfferSession, clock: OfferClock): "disabled" | "closed" | null {
  if (!offer.enabled) return "disabled";
  const closesAt = sessionStart(session, clock.tz).getTime() - offer.bookingClosesHoursBefore * 3_600_000;
  if (clock.now.getTime() >= closesAt) return "closed";
  return null;
}

export function isBookable(offer: Offer, session: OfferSession, taken: number, clock: OfferClock): boolean {
  return bookingBlocker(offer, session, clock) === null && seatsRemaining(session.seats, taken) > 0;
}

/** The earliest bookable session, for the homepage teaser ("Next: …"); null when none. */
export function nextBookable(offer: Offer, takenBySession: ReadonlyMap<string, number>, clock: OfferClock): OfferSession | null {
  const open = offer.sessions
    .filter((s) => isBookable(offer, s, takenBySession.get(s.id) ?? 0, clock))
    .sort((a, b) => sessionStart(a, clock.tz).getTime() - sessionStart(b, clock.tz).getTime());
  return open[0] ?? null;
}

/** "18:00" → "6 pm"; "18:30" → "6:30 pm"; "12:00" → "12 pm"; "00:00" → "12 am". */
export function humanTime(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Sat Nov 7, 6 pm" — the Stripe line item and the emails use this. */
export function sessionLabel(session: OfferSession): string {
  return `${humanDate(session.date)}, ${humanTime(session.start)}`;
}

/** "2 hours", "1 hour", "90 minutes"; empty for zero. */
export function humanDuration(minutes: number): string {
  if (minutes <= 0) return "";
  if (minutes % 60 === 0) { const h = minutes / 60; return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${minutes} minutes`;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/core/offers.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/offers.ts tests/core/offers.test.ts
git commit -m "feat(offers): seat count, booking cutoff and next-session logic (D54)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Bookings table, store, and outbox kinds

**Files:**
- Create: `migrations/0008_bookings.sql`
- Create: `src/store/bookings.ts`
- Modify: `src/store/outbox.ts:1-8` (kinds) and add one function
- Test: `tests/store/bookings.test.ts`

**Interfaces:**
- Produces, in `src/store/bookings.ts`:
  ```ts
  export type BookingStatus = "held" | "paid" | "cancelled";
  export interface Booking {
    id: string; createdAt: number; status: BookingStatus; offerId: string; sessionId: string;
    customerName: string; customerEmail: string; customerPhone: string | null; note: string | null;
    stripeSessionId: string | null; stripePaymentIntent: string | null;
    priceCents: number; taxCents: number; discountCents: number; holdExpiresAt: number | null;
  }
  export interface NewBooking {
    id: string; offerId: string; sessionId: string; customerName: string; customerEmail: string;
    customerPhone: string | null; note: string | null; priceCents: number;
  }
  export function countTaken(db: D1Database, offerId: string): Promise<Map<string, number>>   // sessionId → held + paid
  export function tryInsertHeldBooking(db: D1Database, b: NewBooking, seats: number, now: number, holdExpiresAt: number): Promise<boolean>
  export function attachSession(db: D1Database, bookingId: string, sessionId: string): Promise<void>
  export function getBooking(db: D1Database, id: string): Promise<Booking | null>
  export function markPaidBySession(db: D1Database, sessionId: string, paymentIntent: string, taxCents: number, discountCents: number, extra?: D1PreparedStatement[]): Promise<Booking | null>
  export function cancelHeldBySession(db: D1Database, sessionId: string): Promise<boolean>
  export function cancelBooking(db: D1Database, id: string): Promise<boolean>   // held or paid → cancelled (D53)
  export function expireHolds(db: D1Database, now: number): Promise<number>
  export function listForOffer(db: D1Database, offerId: string): Promise<Booking[]>
  ```
- Produces, in `src/store/outbox.ts`: kinds `"booking_confirmed_customer" | "booking_confirmed_owner"`, `BOOKING_PAID_KINDS`, `isBookingKind(k)`, and
  `enqueueForBookingSessionStatements(db, sessionId, kinds, now): D1PreparedStatement[]` (guarded by "the booking for this Stripe session is paid", like `enqueueForSessionStatements` is for orders).

- [ ] **Step 1: Write the migration**

Create `migrations/0008_bookings.sql`:

```sql
-- Plan 7 (D46, D53): one row per seat booked at a class. Mirrors orders: held while the customer
-- pays on Stripe, paid on the webhook, cancelled on expiry or by admin after a refund in Stripe.
-- Seats taken for a session = rows with status held or paid.
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

- [ ] **Step 2: Write the failing tests**

Create `tests/store/bookings.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  attachSession, cancelBooking, cancelHeldBySession, countTaken, expireHolds, getBooking, listForOffer,
  markPaidBySession, tryInsertHeldBooking, type NewBooking,
} from "../../src/store/bookings";
import { BOOKING_PAID_KINDS, counts, enqueueForBookingSessionStatements } from "../../src/store/outbox";

let n = 0;
function fresh(sessionId = "s1", offerId = "wreath"): NewBooking {
  n += 1;
  return { id: `b${n}`, offerId, sessionId, customerName: "Pat", customerEmail: "pat@example.com", customerPhone: null, note: null, priceCents: 8500 };
}
const NOW = 1_800_000_000;

describe("bookings", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bookings").run();
    await env.DB.prepare("DELETE FROM outbox").run();
  });

  it("inserts while under the seat count, refuses at it", async () => {
    expect(await tryInsertHeldBooking(env.DB, fresh(), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldBooking(env.DB, fresh(), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldBooking(env.DB, fresh(), 2, NOW, NOW + 1800)).toBe(false);
    expect((await countTaken(env.DB, "wreath")).get("s1")).toBe(2);
  });
  it("counts per session and per offer; cancelled rows do not count", async () => {
    const a = fresh("s1"), b = fresh("s2"), c = fresh("s1", "other");
    for (const x of [a, b, c]) expect(await tryInsertHeldBooking(env.DB, x, 8, NOW, NOW + 1800)).toBe(true);
    await cancelBooking(env.DB, a.id);
    const taken = await countTaken(env.DB, "wreath");
    expect(taken.get("s1") ?? 0).toBe(0);
    expect(taken.get("s2")).toBe(1);
    expect((await countTaken(env.DB, "other")).get("s1")).toBe(1);
  });
  it("attaches a session, marks paid once with the tax and discount, ignores a second completion", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_b1");
    const paid = await markPaidBySession(env.DB, "cs_b1", "pi_b1", 680, 0);
    expect(paid).toMatchObject({ id: a.id, status: "paid", stripePaymentIntent: "pi_b1", taxCents: 680, discountCents: 0, holdExpiresAt: null });
    expect(await markPaidBySession(env.DB, "cs_b1", "pi_b1", 680, 0)).toBeNull();
  });
  it("resurrects a hold that expired before a late completion, but never an admin-cancelled paid seat", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 10);
    await attachSession(env.DB, a.id, "cs_b2");
    expect(await expireHolds(env.DB, NOW + 20)).toBe(1);
    expect((await getBooking(env.DB, a.id))?.status).toBe("cancelled");
    expect((await markPaidBySession(env.DB, "cs_b2", "pi_b2", 0, 0))?.status).toBe("paid");
    // Anthony refunds in Stripe and cancels in admin; a replayed completion must not undo that
    expect(await cancelBooking(env.DB, a.id)).toBe(true);
    expect(await markPaidBySession(env.DB, "cs_b2", "pi_b2", 0, 0)).toBeNull();
    expect((await getBooking(env.DB, a.id))?.status).toBe("cancelled");
  });
  it("runs extra statements in the same batch as the paid flip, and the outbox guard holds", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_b3");
    const paid = await markPaidBySession(env.DB, "cs_b3", "pi_b3", 0, 0, enqueueForBookingSessionStatements(env.DB, "cs_b3", BOOKING_PAID_KINDS, NOW));
    expect(paid?.status).toBe("paid");
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    const rows = await env.DB.prepare("SELECT kind, order_id FROM outbox ORDER BY kind").all<any>();
    expect(rows.results).toEqual([
      { kind: "booking_confirmed_customer", order_id: a.id },
      { kind: "booking_confirmed_owner", order_id: a.id },
    ]);
    // a session nobody paid for enqueues nothing
    await env.DB.batch(enqueueForBookingSessionStatements(env.DB, "cs_nobody", BOOKING_PAID_KINDS, NOW));
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
  });
  it("cancels a held booking by session but never a paid one", async () => {
    const a = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_b4");
    await markPaidBySession(env.DB, "cs_b4", "pi_b4", 0, 0);
    expect(await cancelHeldBySession(env.DB, "cs_b4")).toBe(false);
    const b = fresh();
    await tryInsertHeldBooking(env.DB, b, 8, NOW, NOW + 1800);
    await attachSession(env.DB, b.id, "cs_b5");
    expect(await cancelHeldBySession(env.DB, "cs_b5")).toBe(true);
    expect((await getBooking(env.DB, b.id))?.status).toBe("cancelled");
  });
  it("cancelBooking frees a held or paid seat and returns false on a cancelled or unknown one (D53)", async () => {
    const a = fresh("s9");
    await tryInsertHeldBooking(env.DB, a, 1, NOW, NOW + 1800);
    expect(await tryInsertHeldBooking(env.DB, fresh("s9"), 1, NOW, NOW + 1800)).toBe(false);
    expect(await cancelBooking(env.DB, a.id)).toBe(true);
    expect(await cancelBooking(env.DB, a.id)).toBe(false);
    expect(await cancelBooking(env.DB, "nope")).toBe(false);
    expect(await tryInsertHeldBooking(env.DB, fresh("s9"), 1, NOW, NOW + 1800)).toBe(true);
  });
  it("expires holds past their deadline only", async () => {
    const a = fresh(), b = fresh();
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 100);
    await tryInsertHeldBooking(env.DB, b, 8, NOW, NOW + 5000);
    expect(await expireHolds(env.DB, NOW + 200)).toBe(1);
    expect((await getBooking(env.DB, a.id))?.status).toBe("cancelled");
    expect((await getBooking(env.DB, b.id))?.status).toBe("held");
  });
  it("lists an offer's bookings oldest first, every status", async () => {
    const a = fresh("s1"), b = fresh("s2"), c = fresh("s1", "other");
    await tryInsertHeldBooking(env.DB, a, 8, NOW, NOW + 1800);
    await tryInsertHeldBooking(env.DB, b, 8, NOW + 1, NOW + 1800);
    await tryInsertHeldBooking(env.DB, c, 8, NOW + 2, NOW + 1800);
    await cancelBooking(env.DB, b.id);
    expect((await listForOffer(env.DB, "wreath")).map((x) => [x.id, x.status])).toEqual([[a.id, "held"], [b.id, "cancelled"]]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/store/bookings.test.ts`
Expected: FAIL, cannot resolve `../../src/store/bookings` (the migration itself applies cleanly).

- [ ] **Step 4: Implement the store**

Create `src/store/bookings.ts`:

```ts
export type BookingStatus = "held" | "paid" | "cancelled";

export interface Booking {
  id: string; createdAt: number; status: BookingStatus; offerId: string; sessionId: string;
  customerName: string; customerEmail: string; customerPhone: string | null; note: string | null;
  stripeSessionId: string | null; stripePaymentIntent: string | null;
  priceCents: number; taxCents: number; discountCents: number; holdExpiresAt: number | null;
}
export interface NewBooking {
  id: string; offerId: string; sessionId: string; customerName: string; customerEmail: string;
  customerPhone: string | null; note: string | null; priceCents: number;
}

interface Row {
  id: string; created_at: number; status: BookingStatus; offer_id: string; session_id: string;
  customer_name: string; customer_email: string; customer_phone: string | null; note: string | null;
  stripe_session_id: string | null; stripe_payment_intent: string | null;
  price_cents: number; tax_cents: number; discount_cents: number; hold_expires_at: number | null;
}
const COLS = `id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note,
  stripe_session_id, stripe_payment_intent, price_cents, tax_cents, discount_cents, hold_expires_at`;

function fromRow(r: Row): Booking {
  return {
    id: r.id, createdAt: r.created_at, status: r.status, offerId: r.offer_id, sessionId: r.session_id,
    customerName: r.customer_name, customerEmail: r.customer_email, customerPhone: r.customer_phone, note: r.note,
    stripeSessionId: r.stripe_session_id, stripePaymentIntent: r.stripe_payment_intent,
    priceCents: r.price_cents, taxCents: r.tax_cents, discountCents: r.discount_cents, holdExpiresAt: r.hold_expires_at,
  };
}

const TAKEN = `SELECT COUNT(*) FROM bookings WHERE offer_id = ?1 AND session_id = ?2 AND status IN ('held','paid')`;

/** Seats taken per session of one offer (held + paid). Sessions with no bookings are absent. */
export async function countTaken(db: D1Database, offerId: string): Promise<Map<string, number>> {
  const rows = await db.prepare(
    `SELECT session_id, COUNT(*) AS n FROM bookings WHERE offer_id = ? AND status IN ('held','paid') GROUP BY session_id`,
  ).bind(offerId).all<{ session_id: string; n: number }>();
  return new Map(rows.results.map((r) => [r.session_id, r.n]));
}

/** The seat guard: the row lands only while taken < seats, in one statement, so two customers cannot both get the last seat. */
export async function tryInsertHeldBooking(
  db: D1Database, b: NewBooking, seats: number, now: number, holdExpiresAt: number,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note, price_cents, hold_expires_at)
     SELECT ?3, ?4, 'held', ?1, ?2, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE (${TAKEN}) < ?11`,
  ).bind(b.offerId, b.sessionId, b.id, now, b.customerName, b.customerEmail, b.customerPhone, b.note, b.priceCents, holdExpiresAt, seats).run();
  return res.meta.changes === 1;
}

export async function attachSession(db: D1Database, bookingId: string, sessionId: string): Promise<void> {
  await db.prepare("UPDATE bookings SET stripe_session_id = ? WHERE id = ?").bind(sessionId, bookingId).run();
}

export async function getBooking(db: D1Database, id: string): Promise<Booking | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM bookings WHERE id = ?`).bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

/**
 * Flips held → paid with the Stripe amounts, running `extra` (outbox inserts) in the same batch.
 * A hold the expiry job cancelled before a late completion is resurrected (D17), but a seat that
 * was paid and then cancelled in admin after a refund (D53) stays cancelled: that row already
 * carries a payment intent.
 */
export async function markPaidBySession(
  db: D1Database, sessionId: string, paymentIntent: string, taxCents: number, discountCents: number,
  extra: D1PreparedStatement[] = [],
): Promise<Booking | null> {
  const [upd] = await db.batch([
    db.prepare(
      `UPDATE bookings SET status = 'paid', stripe_payment_intent = ?, tax_cents = ?, discount_cents = ?, hold_expires_at = NULL
       WHERE stripe_session_id = ? AND (status = 'held' OR (status = 'cancelled' AND stripe_payment_intent IS NULL))`,
    ).bind(paymentIntent, taxCents, discountCents, sessionId),
    ...extra,
  ]);
  if (upd.meta.changes !== 1) return null;
  const r = await db.prepare(`SELECT ${COLS} FROM bookings WHERE stripe_session_id = ?`).bind(sessionId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function cancelHeldBySession(db: D1Database, sessionId: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE stripe_session_id = ? AND status = 'held'",
  ).bind(sessionId).run();
  return res.meta.changes === 1;
}

/** Admin cancel (D53) and the Stripe-failure path: a held or paid seat is freed. Refunds happen in Stripe. */
export async function cancelBooking(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = ? AND status IN ('held','paid')",
  ).bind(id).run();
  return res.meta.changes === 1;
}

export async function expireHolds(db: D1Database, now: number): Promise<number> {
  const res = await db.prepare(
    "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at <= ?",
  ).bind(now).run();
  return res.meta.changes;
}

export async function listForOffer(db: D1Database, offerId: string): Promise<Booking[]> {
  const rows = await db.prepare(`SELECT ${COLS} FROM bookings WHERE offer_id = ? ORDER BY created_at, id`).bind(offerId).all<Row>();
  return rows.results.map(fromRow);
}
```

- [ ] **Step 5: Add the outbox kinds**

In `src/store/outbox.ts`, replace lines 1–8 (through `export const isSubscriberKind …`) with:

```ts
export type OutboxKind =
  | "calendar_event" | "email_customer" | "email_owner" | "courier_email"
  | "sub_confirmed_customer" | "sub_confirmed_owner" | "sub_cancelled_customer" | "sub_cancelled_owner"
  | "booking_confirmed_customer" | "booking_confirmed_owner";
export const ORDER_PAID_KINDS: readonly OutboxKind[] = ["calendar_event", "email_customer", "email_owner"];
export const SUB_CONFIRMED_KINDS: readonly OutboxKind[] = ["sub_confirmed_customer", "sub_confirmed_owner"];
export const SUB_CANCELLED_KINDS: readonly OutboxKind[] = ["sub_cancelled_customer", "sub_cancelled_owner"];
/** Plan 7: queued with the paid flip of a booking; the subject column carries the booking id. */
export const BOOKING_PAID_KINDS: readonly OutboxKind[] = ["booking_confirmed_customer", "booking_confirmed_owner"];
export const KNOWN_KINDS: readonly string[] = [...ORDER_PAID_KINDS, "courier_email", ...SUB_CONFIRMED_KINDS, ...SUB_CANCELLED_KINDS, ...BOOKING_PAID_KINDS];
export const isSubscriberKind = (k: OutboxKind) => k.startsWith("sub_");
export const isBookingKind = (k: OutboxKind) => k.startsWith("booking_");
```

Add after `enqueueForSessionStatements`:

```ts
/** The booking twin of `enqueueForSessionStatements`: rides in the batch that marks the booking paid; no-op on a duplicate webhook. */
export function enqueueForBookingSessionStatements(
  db: D1Database, sessionId: string, kinds: readonly OutboxKind[], now: number,
): D1PreparedStatement[] {
  return kinds.map((kind) => db.prepare(
    `INSERT OR IGNORE INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at)
     SELECT ?1, ?2, id, ?3, 0, ?3 FROM bookings WHERE stripe_session_id = ?4 AND status = 'paid'`,
  ).bind(crypto.randomUUID(), kind, now, sessionId));
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/store/bookings.test.ts tests/store/outbox.test.ts tests/jobs/outbox.test.ts && npx tsc --noEmit`
Expected: all pass. (`jobs/outbox.test.ts` still passes: its `deliver` switch has a `default` that logs unknown kinds, and no booking rows exist in that file.)

- [ ] **Step 7: Commit**

```bash
git add migrations/0008_bookings.sql src/store/bookings.ts src/store/outbox.ts tests/store/bookings.test.ts
git commit -m "feat(bookings): seats held and paid per session with a guarded insert; booking outbox kinds (D46, D53)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Public API: `GET /api/offers`, `POST /api/book`, the `workshop` tax category

**Files:**
- Modify: `src/adapters/payments.ts:3-4`
- Modify: `src/adapters/stripe.ts:12`
- Modify: `src/routes/public.ts:65-78` (extract `parseCustomer`)
- Create: `src/routes/offers.ts`
- Modify: `src/app.ts`
- Modify: `tests/helpers.ts`
- Test: `tests/routes/offers.test.ts`, `tests/adapters/stripe.test.ts`

**Interfaces:**
- Consumes: `offersOf`, `offerById`, `Offer`, `OfferSession` (Task 1); `bookingBlocker`, `isBookable`, `seatsRemaining`, `sessionLabel` (Task 2); `countTaken`, `tryInsertHeldBooking`, `attachSession`, `cancelBooking` (Task 3).
- Produces:
  - `TaxCategory` gains `"workshop"`; `TAX_CODES.workshop = "txcd_99999999"`.
  - `src/routes/public.ts` exports `interface Customer { name: string; email: string; phone?: string }` and `parseCustomer(raw: unknown): { ok: true; customer: Customer } | { ok: false; error: string }`.
  - `src/routes/offers.ts` exports `offerRoutes(): App` mounted in `buildApp` after `publicRoutes()`.
  - `GET /api/offers` → `{ offers: PublicOffer[], marketing: { metaPixelId: string } }` where
    `PublicOffer = { id, slug, name, tagline, description, image, imageAlt, priceCents, durationMinutes, bookingClosesHoursBefore, showOnHome, sessions: Array<{ id, date, start, seats, remaining, bookable }> }`;
    only enabled offers; only sessions with `date >= today` in the studio timezone, sorted by date then start.
  - `POST /api/book { offerId, sessionId, customer: { name, email, phone? }, note? }` → `{ url }`; errors as spec §3.6.
  - `tests/helpers.ts`: `testApp(now?, config?)`, `testServices(now?, config?)`, and the fixtures `WREATH: Offer`, `OFF_OFFER: Offer`, `offersConfig(): StoreConfig`.

- [ ] **Step 1: Extend the test helpers**

In `tests/helpers.ts`, change the imports and add the fixtures. Replace `import { loadConfig } from "../src/config";` with:

```ts
import { loadConfig, type Offer, type StoreConfig } from "../src/config";
```

Add after `peekNextSessionId`:

```ts
/**
 * Plan 7 fixtures. Dated against testApp's default clock (Tue 2026-09-08 10:00 EDT):
 *  - "past"  is before today and never appears in /api/offers;
 *  - "today" starts in five hours, inside the 24-hour cutoff, so it is listed but closed;
 *  - "sat"   is four days out with two seats: the bookable one.
 * The repo config's own offer is never used by tests (its values are Ryan's to change).
 */
export const WREATH: Offer = {
  id: "wreath-test", slug: "wreath-test", enabled: true, showOnHome: true, name: "Wreath & Sip",
  tagline: "Make an autumn wreath at the studio", description: "An evening at the studio.", image: "assets/wreath.jpg", imageAlt: "An autumn wreath",
  priceCents: 8500, durationMinutes: 120, bookingClosesHoursBefore: 24,
  sessions: [
    { id: "past", date: "2026-09-01", start: "18:00", seats: 8 },
    { id: "today", date: "2026-09-08", start: "15:00", seats: 8 },
    { id: "sat", date: "2026-09-12", start: "18:00", seats: 2 },
  ],
};
export const OFF_OFFER: Offer = { ...WREATH, id: "off-test", slug: "off-test", enabled: false, showOnHome: false };
export function offersConfig(offers: Offer[] = [WREATH, OFF_OFFER], metaPixelId = ""): StoreConfig {
  return { ...loadConfig(), offers, marketing: { metaPixelId } };
}
```

Change the two factory signatures:

```ts
export function testApp(now = new Date("2026-09-08T14:00:00Z"), config: StoreConfig = loadConfig()) {
  …
  const app = buildApp({ payments, google, instagram, uber, access, clock: () => now, config });
```
and
```ts
export function testServices(now = new Date("2026-09-08T14:00:00Z"), config: StoreConfig = loadConfig()) {
  …
  return { services: { payments, google, instagram, uber, access, clock: () => now, config }, payments, google, instagram, uber, access };
```

- [ ] **Step 2: Write the failing tests**

In `tests/adapters/stripe.test.ts`, inside the describe that holds the line-item tax-code test (line 61), add:

```ts
  it("maps the workshop category to the general tangible goods code (Plan 7 §3.6)", () => {
    const p = checkoutParams({
      orderId: "b1", customerEmail: "pat@example.com", customerName: "Pat", taxAddress: loadConfig().studio.address,
      lineItems: [{ name: "Wreath & Sip — Sat Nov 7, 6 pm", amountCents: 8500, quantity: 1, taxCategory: "workshop" }],
      successUrl: "https://x.test/thanks", cancelUrl: "https://x.test/offers/w", expiresAt: 1,
    }, "cus_1");
    expect(p.line_items![0].price_data!.product_data!.tax_code).toBe("txcd_99999999");
    expect(p.line_items![0].price_data!.tax_behavior).toBe("exclusive");
  });
```
(If `checkoutParams` or `loadConfig` are not already imported in that file, add them: `import { checkoutParams } from "../../src/adapters/stripe";` and `import { loadConfig } from "../../src/config";`.)

Create `tests/routes/offers.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp, offersConfig, WREATH, OFF_OFFER } from "../helpers";
import { loadConfig } from "../../src/config";
import { tryInsertHeldBooking } from "../../src/store/bookings";

const NOW_SEC = Math.floor(new Date("2026-09-08T14:00:00Z").getTime() / 1000);
const good = { offerId: WREATH.id, sessionId: "sat", customer: { name: "Jane Doe", email: "jane@example.com", phone: "518-555-0100" }, note: "first wreath" };
const post = (fetch: any, body: unknown) =>
  fetch("/api/book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function held(id: string, sessionId: string, offerId = WREATH.id) {
  await tryInsertHeldBooking(env.DB, { id, offerId, sessionId, customerName: "X", customerEmail: "x@example.com", customerPhone: null, note: null, priceCents: 8500 }, 99, NOW_SEC, NOW_SEC + 1800);
}

describe("GET /api/offers", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM bookings").run(); });

  it("lists enabled offers with today-onward sessions, remaining seats and bookable, and the pixel id", async () => {
    await held("h1", "sat");
    await held("h2", "sat");
    await env.DB.prepare("UPDATE bookings SET status = 'paid' WHERE id = 'h2'").run();
    const { fetch } = testApp(undefined, offersConfig([WREATH, OFF_OFFER], "123"));
    const r = await fetch("/api/offers");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.marketing).toEqual({ metaPixelId: "123" });
    expect(body.offers.map((o: any) => o.id)).toEqual([WREATH.id]);
    const o = body.offers[0];
    expect(o).toMatchObject({ slug: "wreath-test", name: "Wreath & Sip", priceCents: 8500, durationMinutes: 120, showOnHome: true, image: "assets/wreath.jpg" });
    expect(o).not.toHaveProperty("enabled");
    expect(o.sessions).toEqual([
      { id: "today", date: "2026-09-08", start: "15:00", seats: 8, remaining: 8, bookable: false },
      { id: "sat", date: "2026-09-12", start: "18:00", seats: 2, remaining: 0, bookable: false },
    ]);
    expect(JSON.stringify(body)).not.toContain("x@example.com");
  });
  it("a cancelled booking frees its seat", async () => {
    await held("h3", "sat");
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = 'h3'").run();
    const { fetch } = testApp(undefined, offersConfig());
    const { offers } = await (await fetch("/api/offers")).json() as any;
    expect(offers[0].sessions.find((s: any) => s.id === "sat")).toMatchObject({ remaining: 2, bookable: true });
  });
  it("returns no offers and an empty pixel id when the config has neither key", async () => {
    const { offers: _o, marketing: _m, ...bare } = loadConfig();
    const { fetch } = testApp(undefined, bare as any);
    expect(await (await fetch("/api/offers")).json()).toEqual({ offers: [], marketing: { metaPixelId: "" } });
  });
});

describe("POST /api/book", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM bookings").run(); });

  it("holds a seat, creates a Checkout Session for one seat at the studio, returns the url", async () => {
    const { fetch, payments } = testApp(undefined, offersConfig());
    const r = await post(fetch, good);
    expect(r.status).toBe(200);
    const { url } = await r.json() as any;
    expect(url).toMatch(/^https:\/\/checkout\.example\//);
    const c = payments.created[0];
    expect(c.lineItems).toEqual([{ name: "Wreath & Sip — Sat Sep 12, 6 pm", amountCents: 8500, quantity: 1, taxCategory: "workshop" }]);
    expect(c.taxAddress).toEqual(loadConfig().studio.address);
    expect(c.customerEmail).toBe("jane@example.com");
    expect(c.expiresAt).toBe(NOW_SEC + 30 * 60 + 60);
    expect(c.successUrl).toBe(`https://thebullandbloom.com/thanks?booking=${c.orderId}&offer=${WREATH.id}`);
    expect(c.cancelUrl).toBe("https://thebullandbloom.com/offers/wreath-test");
    const row = await env.DB.prepare("SELECT status, offer_id, session_id, customer_name, customer_phone, note, price_cents, stripe_session_id, hold_expires_at FROM bookings WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toMatchObject({ status: "held", offer_id: WREATH.id, session_id: "sat", customer_name: "Jane Doe", customer_phone: "518-555-0100", note: "first wreath", price_cents: 8500, hold_expires_at: c.expiresAt + 120 });
    expect(row.stripe_session_id).toMatch(/^cs_/);
  });
  it("sells the last seat once under two concurrent posts and says sold_out to the other", async () => {
    await held("h4", "sat");
    const { fetch, payments } = testApp(undefined, offersConfig());
    const [a, b] = await Promise.all([post(fetch, good), post(fetch, good)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(await lost.json()).toEqual({ error: "sold_out" });
    expect(payments.created).toHaveLength(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE session_id = 'sat' AND status = 'held'").first<any>();
    expect(n.n).toBe(2);
  });
  it("says closed inside the cutoff, disabled for an offer that is off, and never touches Stripe", async () => {
    const { fetch, payments } = testApp(undefined, offersConfig());
    const closed = await post(fetch, { ...good, sessionId: "today" });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({ error: "closed" });
    const past = await post(fetch, { ...good, sessionId: "past" });
    expect(await past.json()).toEqual({ error: "closed" });
    const off = await post(fetch, { ...good, offerId: OFF_OFFER.id });
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "disabled" });
    expect(payments.created).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings").first<any>()).n).toBe(0);
  });
  it("validates the body", async () => {
    const { fetch } = testApp(undefined, offersConfig());
    expect((await fetch("/api/book", { method: "POST", body: "{" })).status).toBe(400);
    expect((await post(fetch, { ...good, offerId: "nope" })).status).toBe(400);
    expect((await post(fetch, { ...good, sessionId: "nope" })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "", email: "jane@example.com" } })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "Jane", email: "not-an-email" } })).status).toBe(400);
    expect((await post(fetch, { ...good, note: "x".repeat(501) })).status).toBe(400);
    const { offerId: _o, ...noOffer } = good;
    expect((await post(fetch, noOffer)).status).toBe(400);
  });
  it("releases the seat and returns 503 when Stripe fails", async () => {
    const { fetch, payments } = testApp(undefined, offersConfig());
    payments.failNext = true;
    const r = await post(fetch, good);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "payments_unavailable" });
    const rows = await env.DB.prepare("SELECT status FROM bookings").all<any>();
    expect(rows.results).toEqual([{ status: "cancelled" }]);
    // the seat is free again
    expect((await post(fetch, good)).status).toBe(200);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/routes/offers.test.ts tests/adapters/stripe.test.ts`
Expected: the offers tests fail with 404s (no routes); the stripe test fails typecheck/`undefined` on the `workshop` category.

- [ ] **Step 4: Add the tax category**

`src/adapters/payments.ts` line 3–4:

```ts
/** Which Stripe tax code a line carries (spec Plan 5 D37; `workshop` is a class seat, Plan 7 §3.6). */
export type TaxCategory = "flowers" | "vase" | "delivery" | "workshop";
```

`src/adapters/stripe.ts` line 12:

```ts
/** Stripe Tax codes. No floral-specific code exists; shipping lets Stripe apply NY's taxable-delivery rule.
 *  A class seat leaves with a wreath, so it is general tangible goods too (Plan 7 §3.6). */
const TAX_CODES: Record<TaxCategory, string> = { flowers: "txcd_99999999", vase: "txcd_99999999", delivery: "txcd_92010001", workshop: "txcd_99999999" };
```

- [ ] **Step 5: Extract `parseCustomer` in `src/routes/public.ts`**

Add after the `CheckoutBody` interface:

```ts
export interface Customer { name: string; email: string; phone?: string }

/** The customer block every paid form sends (checkout, and /api/book in Plan 7): name ≤120, a real email ≤200, phone ≤40. */
export function parseCustomer(raw: unknown): { ok: true; customer: Customer } | { ok: false; error: string } {
  const c = raw as any;
  if (!c || typeof c.name !== "string" || c.name.trim().length < 1 || c.name.trim().length > 120) return { ok: false, error: "name required" };
  if (typeof c.email !== "string" || !EMAIL.test(c.email) || c.email.length > 200) return { ok: false, error: "valid email required" };
  if (c.phone !== undefined && (typeof c.phone !== "string" || c.phone.length > 40)) return { ok: false, error: "phone too long" };
  return { ok: true, customer: { name: c.name.trim(), email: c.email.trim(), phone: c.phone?.trim() || undefined } };
}
```

In `parseCheckout`, replace the four lines from `const c = b.customer;` through the `phone too long` check with:

```ts
  const cust = parseCustomer(b.customer);
  if (!cust.ok) return cust;
```
Replace `if (normalizePhone(c.phone) === null)` with `if (normalizePhone(cust.customer.phone) === null)`, and in the final return replace `customer: { name: c.name.trim(), email: c.email.trim(), phone: c.phone?.trim() || undefined },` with `customer: cust.customer,`.

Run `npx vitest run tests/routes/public.test.ts` here: every existing checkout test must still pass before moving on.

- [ ] **Step 6: Write the routes**

Create `src/routes/offers.ts`:

```ts
import { Hono } from "hono";
import type { App } from "../app";
import { offerById, offersOf } from "../config";
import { bookingBlocker, isBookable, seatsRemaining, sessionLabel, sessionStart } from "../core/offers";
import { ymdIn } from "../core/time";
import { attachSession, cancelBooking, countTaken, tryInsertHeldBooking } from "../store/bookings";
import type { CheckoutLineItem } from "../adapters/payments";
import { parseCustomer } from "./public";

/** Plan 7: classes sold by the seat. Config is the catalog (D47); D1 counts the seats. */
export function offerRoutes(): App {
  const r: App = new Hono();

  r.get("/api/offers", async (c) => {
    const { config, clock } = c.get("services");
    const now = clock();
    const clk = { now, tz: config.timezone };
    const today = ymdIn(config.timezone, now);
    const offers = [];
    for (const o of offersOf(config).filter((x) => x.enabled)) {
      const taken = await countTaken(c.env.DB, o.id);
      const sessions = o.sessions
        .filter((s) => s.date >= today)
        .sort((a, b) => sessionStart(a, clk.tz).getTime() - sessionStart(b, clk.tz).getTime())
        .map((s) => {
          const t = taken.get(s.id) ?? 0;
          return { id: s.id, date: s.date, start: s.start, seats: s.seats, remaining: seatsRemaining(s.seats, t), bookable: isBookable(o, s, t, clk) };
        });
      offers.push({
        id: o.id, slug: o.slug, name: o.name, tagline: o.tagline, description: o.description, image: o.image, imageAlt: o.imageAlt,
        priceCents: o.priceCents, durationMinutes: o.durationMinutes, bookingClosesHoursBefore: o.bookingClosesHoursBefore,
        showOnHome: o.showOnHome, sessions,
      });
    }
    return c.json({ offers, marketing: { metaPixelId: config.marketing?.metaPixelId ?? "" } });
  });

  r.post("/api/book", async (c) => {
    const { config, clock, payments } = c.get("services");
    let b: any;
    try { b = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (!b || typeof b !== "object") return c.json({ error: "body must be an object" }, 400);
    if (typeof b.offerId !== "string" || typeof b.sessionId !== "string") return c.json({ error: "offerId and sessionId required" }, 400);
    const cust = parseCustomer(b.customer);
    if (!cust.ok) return c.json({ error: cust.error }, 400);
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) return c.json({ error: "note must be 500 characters or fewer" }, 400);
    const offer = offerById(config, b.offerId);
    if (!offer) return c.json({ error: "unknown offer" }, 400);
    const session = offer.sessions.find((s) => s.id === b.sessionId);
    if (!session) return c.json({ error: "unknown session" }, 400);

    const now = clock();
    const blocker = bookingBlocker(offer, session, { now, tz: config.timezone });
    if (blocker) return c.json({ error: blocker }, 409);

    // D16, as /api/checkout: Stripe's expiry 60s past the hold window, our hold 120s past that.
    const nowSec = Math.floor(now.getTime() / 1000);
    const stripeExpiresAt = nowSec + config.holdMinutes * 60 + 60;
    const holdUntil = stripeExpiresAt + 120;
    const bookingId = crypto.randomUUID();
    const inserted = await tryInsertHeldBooking(c.env.DB, {
      id: bookingId, offerId: offer.id, sessionId: session.id,
      customerName: cust.customer.name, customerEmail: cust.customer.email, customerPhone: cust.customer.phone ?? null,
      note: b.note?.trim() || null, priceCents: offer.priceCents,
    }, session.seats, nowSec, holdUntil);
    if (!inserted) return c.json({ error: "sold_out" }, 409);

    const lineItems: CheckoutLineItem[] = [
      { name: `${offer.name} — ${sessionLabel(session)}`, amountCents: offer.priceCents, quantity: 1, taxCategory: "workshop" },
    ];
    let stripeSession;
    try {
      stripeSession = await payments.createCheckout({
        orderId: bookingId, customerEmail: cust.customer.email, customerName: cust.customer.name,
        taxAddress: config.studio.address, lineItems,
        successUrl: `${c.env.SITE_URL}/thanks?booking=${bookingId}&offer=${offer.id}`,
        cancelUrl: `${c.env.SITE_URL}/offers/${offer.slug}`,
        expiresAt: stripeExpiresAt,
      });
    } catch (err) {
      await cancelBooking(c.env.DB, bookingId);
      console.error("book: payments failed", err);
      return c.json({ error: "payments_unavailable" }, 503);
    }
    try {
      await attachSession(c.env.DB, bookingId, stripeSession.id);
    } catch (err) {
      await cancelBooking(c.env.DB, bookingId);
      console.error(`book: attach failed after session ${stripeSession.id}`, err);
      return c.json({ error: "payments_unavailable" }, 503);
    }
    return c.json({ url: stripeSession.url });
  });

  return r;
}
```

(`CheckoutInput.orderId` carries the booking id; Stripe's `client_reference_id` and `metadata.order_id` therefore hold the booking id for a seat. That is fine: nothing reads them back, and the webhook keys on the session id.)

In `src/app.ts`, add `import { offerRoutes } from "./routes/offers";` and, after `app.route("/", publicRoutes());`, add `app.route("/", offerRoutes());`.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run tests/routes/offers.test.ts tests/routes/public.test.ts tests/adapters/stripe.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 8: Run the whole suite**

Run: `npx vitest run`
Expected: everything green (the helpers' default arguments keep every existing caller working).

- [ ] **Step 9: Commit**

```bash
git add src/adapters/payments.ts src/adapters/stripe.ts src/routes/public.ts src/routes/offers.ts src/app.ts tests/helpers.ts tests/routes/offers.test.ts tests/adapters/stripe.test.ts
git commit -m "feat(offers): /api/offers lists seats and /api/book holds one through Stripe Checkout (D46, D48)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Booking emails and outbox delivery

**Files:**
- Create: `src/core/booking-messages.ts`
- Modify: `src/jobs/outbox.ts`
- Test: `tests/core/booking-messages.test.ts`, `tests/jobs/outbox.test.ts`

**Interfaces:**
- Consumes: `Booking`, `getBooking`, `countTaken` (Task 3); `Offer`, `OfferSession`, `offerById` (Task 1); `sessionLabel`, `humanTime`, `humanDuration` (Task 2); `formatAddress` from `src/core/messages.ts`; `longDate` from `src/core/time.ts`; `isBookingKind` (Task 3).
- Produces, in `src/core/booking-messages.ts`:
  ```ts
  export function prettyPhone(e164: string): string   // "+15183340517" → "(518) 334-0517"; anything else unchanged
  export function bookingConfirmedEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig): Mail
  export function ownerBookingEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig, taken: number, siteUrl: string): Mail
  ```
- `drainOutbox` delivers `booking_confirmed_customer` and `booking_confirmed_owner`: loads the booking by `item.orderId`; drops (returns false) when the booking is missing or not `paid`; **throws** when the offer or session is no longer in config (so the row retries and surfaces in the admin failed count instead of vanishing).

- [ ] **Step 1: Write the failing message tests**

Create `tests/core/booking-messages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bookingConfirmedEmail, ownerBookingEmail, prettyPhone } from "../../src/core/booking-messages";
import { loadConfig } from "../../src/config";
import type { Booking } from "../../src/store/bookings";
import { WREATH } from "../helpers";

const cfg = loadConfig();
const session = WREATH.sessions.find((s) => s.id === "sat")!; // Sat Sep 12, 6 pm
const booking: Booking = {
  id: "b1", createdAt: 1, status: "paid", offerId: WREATH.id, sessionId: "sat",
  customerName: "Jane Doe", customerEmail: "jane@example.com", customerPhone: "518-555-0100", note: "first wreath",
  stripeSessionId: "cs_1", stripePaymentIntent: "pi_1", priceCents: 8500, taxCents: 680, discountCents: 0, holdExpiresAt: null,
};

describe("booking messages (D50: home studio named, refreshments promised, nothing more specific)", () => {
  it("formats the studio phone", () => {
    expect(prettyPhone("+15183340517")).toBe("(518) 334-0517");
    expect(prettyPhone("+441234567890")).toBe("+441234567890");
  });
  it("customer email carries the date, time, length, the home-studio address, materials, refreshments and the contact", () => {
    const m = bookingConfirmedEmail(booking, WREATH, session, cfg);
    expect(m.to).toBe("jane@example.com");
    expect(m.subject).toBe("Your seat at Wreath & Sip");
    expect(m.text).toContain("Hi Jane,");
    expect(m.text).toContain("Your seat is saved for Wreath & Sip on Saturday, September 12 at 6 pm. Plan on about 2 hours.");
    expect(m.text).toContain("Where: Anthony's home studio");
    expect(m.text).toContain(`${cfg.studio.address.street}, ${cfg.studio.address.city}, ${cfg.studio.address.state} ${cfg.studio.address.zip}`);
    expect(m.text).toContain("Everything you need to make your wreath is provided, and it goes home with you.");
    expect(m.text).toContain("Refreshments will be provided.");
    expect(m.text).toContain("Can't make it? Email or call Anthony as soon as you know.");
    expect(m.text).toContain(`${prettyPhone(cfg.studio.phone)}`);
    expect(m.text).toContain(cfg.studio.ownerEmail);
    expect(m.text).not.toMatch(/wine|beer|cocktail|bring/i);
    expect(m.text.trim().endsWith("Anthony\nThe Bull and Bloom\nthebullandbloom.com")).toBe(true);
  });
  it("customer email leaves out the length when the offer has none", () => {
    const m = bookingConfirmedEmail(booking, { ...WREATH, durationMinutes: 0 }, session, cfg);
    expect(m.text).toContain("at 6 pm.\n");
    expect(m.text).not.toContain("Plan on");
  });
  it("owner email names who booked, the date and the headcount, with contact and note", () => {
    const m = ownerBookingEmail(booking, WREATH, session, cfg, 5, "https://x.test");
    expect(m.to).toBe(cfg.studio.ownerEmail);
    expect(m.subject).toBe("Jane Doe booked Wreath & Sip, Sat Sep 12 — 5 of 2 seats");
    expect(m.text).toContain("jane@example.com · 518-555-0100");
    expect(m.text).toContain("Note: first wreath");
    expect(m.text).toContain("Sat Sep 12, 6 pm · 5 of 2 seats taken");
    expect(m.text).toContain("https://x.test/admin/");
    const quiet = ownerBookingEmail({ ...booking, customerPhone: null, note: null }, WREATH, session, cfg, 1, "https://x.test");
    expect(quiet.text).not.toContain("Note:");
    expect(quiet.text).toContain("jane@example.com\n");
  });
});
```

(The "5 of 2" in the subject is deliberate: the fixture session has two seats and the test passes five as `taken` to prove the number comes from the argument, not the session.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/booking-messages.test.ts`
Expected: FAIL, cannot resolve `../../src/core/booking-messages`.

- [ ] **Step 3: Write the messages**

Create `src/core/booking-messages.ts`:

```ts
import type { Mail } from "../adapters/google";
import type { Offer, OfferSession, StoreConfig } from "../config";
import type { Booking } from "../store/bookings";
import { formatAddress } from "./messages";
import { humanDuration, humanTime, sessionLabel } from "./offers";
import { humanDate, longDate } from "./time";

/** "+15183340517" → "(518) 334-0517"; any other shape is returned as given. */
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const firstNameOf = (name: string) => name.trim().split(/\s+/)[0];

/**
 * Plan 7 §3.7, D50. The only place the street address reaches a customer. The cancellation line is
 * the §6 default (no refund promise either way) until Ryan and Anthony replace it.
 */
export function bookingConfirmedEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig): Mail {
  const length = humanDuration(offer.durationMinutes);
  const lines = [
    `Hi ${firstNameOf(booking.customerName)},`,
    "",
    `Your seat is saved for ${offer.name} on ${longDate(session.date)} at ${humanTime(session.start)}.${length ? ` Plan on about ${length}.` : ""}`,
    "",
    "Where: Anthony's home studio",
    formatAddress(cfg.studio.address),
    "",
    "Everything you need to make your wreath is provided, and it goes home with you.",
    "Refreshments will be provided.",
    "",
    "Can't make it? Email or call Anthony as soon as you know.",
    "",
    `Questions? Reply to this email or call ${prettyPhone(cfg.studio.phone)}.`,
    cfg.studio.ownerEmail,
    "",
    "Anthony",
    "The Bull and Bloom",
    "thebullandbloom.com",
  ];
  return { to: booking.customerEmail, subject: `Your seat at ${offer.name}`, text: lines.join("\n") };
}

/** "Jane Doe booked Wreath & Sip, Sat Nov 7 — 5 of 8 seats": the headcount is what Anthony needs (D52). */
export function ownerBookingEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig, taken: number, siteUrl: string): Mail {
  const contact = booking.customerPhone ? `${booking.customerEmail} · ${booking.customerPhone}` : booking.customerEmail;
  const lines = [
    `${offer.name} · ${sessionLabel(session)} · ${taken} of ${session.seats} seats taken`,
    "",
    booking.customerName,
    contact,
  ];
  if (booking.note) lines.push(`Note: ${booking.note}`);
  lines.push("", `Booking ${booking.id.slice(0, 8)} · paid online`, `${siteUrl}/admin/`);
  return {
    to: cfg.studio.ownerEmail,
    subject: `${booking.customerName} booked ${offer.name}, ${humanDate(session.date)} — ${taken} of ${session.seats} seats`,
    text: lines.join("\n"),
  };
}
```

Note on "your wreath": the spec says nothing in the build is wreath-specific, but this sentence is the D50 copy for the first offer. Keep it as the committed draft; it is one of the §6 blanks ("Customer email wording") Ryan edits in Task 11.

- [ ] **Step 4: Run the message tests**

Run: `npx vitest run tests/core/booking-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing outbox tests**

In `tests/jobs/outbox.test.ts`:

Change `import { RecordingPayments } from "../helpers";` to `import { RecordingPayments, WREATH, offersConfig } from "../helpers";` and add `import { BOOKING_PAID_KINDS, enqueueForBookingSessionStatements } from "../../src/store/outbox";` (merge into the existing outbox import line). Change the `deps` helper to accept a config:

```ts
const deps = (google: FakeGoogle, config = cfg) => ({ db: env.DB, google, payments: new RecordingPayments(), config, siteUrl: "https://x.test" });
```

Add a helper after `paidDeliveryOrder`:

```ts
async function paidBooking(id: string, session: string, sessionId = "sat", offerId = WREATH.id) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note, price_cents, stripe_session_id)
     VALUES (?, 1, 'paid', ?, ?, 'Jane Doe', 'jane@example.com', '518-555-0100', 'first wreath', 8500, ?)`,
  ).bind(id, offerId, sessionId, session).run();
  await env.DB.batch(enqueueForBookingSessionStatements(env.DB, session, BOOKING_PAID_KINDS, NOW_SEC));
}
```

Add `await env.DB.prepare("DELETE FROM bookings").run();` to the `beforeEach`. Add a describe at the end of the top-level `describe("drainOutbox", …)`:

```ts
  describe("booking emails (Plan 7)", () => {
    it("sends the customer confirmation and Anthony's headcount email", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk1", "cs_bk1");
      await env.DB.prepare(`INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, price_cents)
        VALUES ('bk1b', 1, 'held', ?, 'sat', 'B', 'b@example.com', 8500)`).bind(WREATH.id).run();
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 2, failed: 0 });
      const customer = g.sent.find((m) => m.to === "jane@example.com")!;
      expect(customer.subject).toBe("Your seat at Wreath & Sip");
      expect(customer.text).toContain("Refreshments will be provided.");
      expect(customer.text).toContain(cfg.studio.address.street);
      const owner = g.sent.find((m) => m.to === cfg.studio.ownerEmail)!;
      expect(owner.subject).toBe("Jane Doe booked Wreath & Sip, Sat Sep 12 — 2 of 2 seats");
      expect(owner.text).toContain("518-555-0100");
      expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
      expect(g.sent).toHaveLength(2);
    });
    it("drops both emails when the booking is no longer paid", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk2", "cs_bk2");
      await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = 'bk2'").run();
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
      expect(g.sent).toHaveLength(0);
      expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    });
    it("keeps retrying when the session has been removed from config, so the loss is visible", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk3", "cs_bk3", "gone");
      const g = new FakeGoogle();
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 0, failed: 2 });
      const row = await env.DB.prepare("SELECT last_error FROM outbox WHERE order_id = 'bk3' LIMIT 1").first<any>();
      expect(row.last_error).toContain("gone");
      expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    });
    it("retries with backoff when Gmail is down", async () => {
      await saveState(env.DB, STATE);
      await paidBooking("bk4", "cs_bk4");
      const g = new FakeGoogle();
      g.failNext = "gmail down";
      expect(await drainOutbox(deps(g, offersConfig()), NOW)).toEqual({ status: "ok", delivered: 1, failed: 1 });
      expect(await drainOutbox(deps(g, offersConfig()), new Date((NOW_SEC + 120) * 1000))).toEqual({ status: "ok", delivered: 1, failed: 0 });
      expect(g.sent).toHaveLength(2);
    });
  });
```

- [ ] **Step 6: Run the outbox tests to verify they fail**

Run: `npx vitest run tests/jobs/outbox.test.ts`
Expected: the four new tests fail (`delivered: 0` with "unknown order kind" logged; the drop test passes by accident, that is fine).

- [ ] **Step 7: Deliver the booking kinds**

In `src/jobs/outbox.ts`:

Add imports:

```ts
import { bookingConfirmedEmail, ownerBookingEmail } from "../core/booking-messages";
import { offerById } from "../config";
import { countTaken, getBooking } from "../store/bookings";
```
and add `isBookingKind` to the import from `../store/outbox`.

In `deliver`, add as the first line of the body:

```ts
  if (isBookingKind(item.kind)) return deliverBooking(deps, item);
```

Add after `deliverSubscriber`:

```ts
/** Booking emails (Plan 7): the outbox subject is the booking id. */
async function deliverBooking(deps: OutboxDeps, item: OutboxItem): Promise<boolean> {
  const booking = await getBooking(deps.db, item.orderId);
  if (!booking || booking.status !== "paid") {
    console.error(`outbox: booking ${item.orderId} is ${booking?.status ?? "missing"}; dropping ${item.kind}`);
    return false;
  }
  const offer = offerById(deps.config, booking.offerId);
  const session = offer?.sessions.find((s) => s.id === booking.sessionId);
  // A paid seat whose offer or session left the config is a real problem; retry (and eventually
  // show as failed in admin) rather than silently dropping the customer's confirmation.
  if (!offer || !session) throw new Error(`booking ${booking.id}: offer ${booking.offerId} session ${booking.sessionId} is not in config`);
  switch (item.kind) {
    case "booking_confirmed_customer": await deps.google.sendMail(bookingConfirmedEmail(booking, offer, session, deps.config)); return true;
    case "booking_confirmed_owner": {
      const taken = (await countTaken(deps.db, offer.id)).get(session.id) ?? 0;
      await deps.google.sendMail(ownerBookingEmail(booking, offer, session, deps.config, taken, deps.siteUrl));
      return true;
    }
    default: console.error(`outbox: unknown booking kind ${item.kind}`); return false;
  }
}
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `npx vitest run tests/jobs/outbox.test.ts tests/core/booking-messages.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/core/booking-messages.ts src/jobs/outbox.ts tests/core/booking-messages.test.ts tests/jobs/outbox.test.ts
git commit -m "feat(outbox): booking confirmation for the customer and a headcount email for Anthony (D50, D52)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Webhook marks bookings paid; scheduled job expires booking holds

**Files:**
- Modify: `src/routes/webhooks.ts:22-50`
- Modify: `src/scheduled.ts`
- Test: `tests/routes/webhooks.test.ts`, `tests/scheduled.test.ts`

**Interfaces:**
- Consumes: `markPaidBySession`, `cancelHeldBySession`, `expireHolds` from `src/store/bookings.ts` (Task 3), `enqueueForBookingSessionStatements`, `BOOKING_PAID_KINDS` (Task 3).
- Produces: `ScheduledReport.expiredBookingHolds: number | { error: string }`. Webhook responses: `applied: "paid"` for a booking completion too; `applied: "cancelled"` for a booking expiry.

- [ ] **Step 1: Write the failing tests**

In `tests/routes/webhooks.test.ts`, add a helper after `heldOrder`:

```ts
async function heldBooking(id: string, session: string) {
  await env.DB.prepare(
    `INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, price_cents, stripe_session_id, hold_expires_at)
     VALUES (?, 1, 'held', 'wreath-test', 'sat', 'Jane', 'jane@example.com', 8500, ?, 99)`,
  ).bind(id, session).run();
}
```

Add a describe at the end of the file:

```ts
describe("POST /webhooks/stripe → bookings (Plan 7)", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM bookings").run();
  });
  it("marks a booking paid when no order matches the session, queues both emails, and is idempotent", async () => {
    await heldBooking("bw1", "cs_bw1");
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_bw1", paymentIntent: "pi_bw1", taxCents: 680, discountCents: 0 };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paid" });
    const row = await env.DB.prepare("SELECT status, stripe_payment_intent, tax_cents, hold_expires_at FROM bookings WHERE id = 'bw1'").first<any>();
    expect(row).toEqual({ status: "paid", stripe_payment_intent: "pi_bw1", tax_cents: 680, hold_expires_at: null });
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    const kinds = await env.DB.prepare("SELECT kind FROM outbox WHERE order_id = 'bw1' ORDER BY kind").all<any>();
    expect(kinds.results.map((k) => k.kind)).toEqual(["booking_confirmed_customer", "booking_confirmed_owner"]);
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
  });
  it("still marks an order paid first when both tables could match", async () => {
    await heldOrder("ow1", "cs_shared");
    await heldBooking("bw2", "cs_other");
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_shared", paymentIntent: "pi_s", taxCents: 0, discountCents: 0 };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paid" });
    expect((await env.DB.prepare("SELECT status FROM bookings WHERE id = 'bw2'").first<any>()).status).toBe("held");
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id = 'ow1'").first<any>()).status).toBe("paid");
  });
  it("cancels a held booking on expiry", async () => {
    await heldBooking("bw3", "cs_bw3");
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.expired", sessionId: "cs_bw3" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "cancelled" });
    expect((await env.DB.prepare("SELECT status FROM bookings WHERE id = 'bw3'").first<any>()).status).toBe("cancelled");
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
  });
});
```

In `tests/scheduled.test.ts`, add a booking row to the first test and the new report field. Replace the body of "expires stale holds and reports the Google jobs as skipped when not connected" with:

```ts
    const now = 1_800_000_000;
    await env.DB.batch([env.DB.prepare(ORDER).bind("s1", now - 1), env.DB.prepare(ORDER).bind("s2", now + 600)]);
    await env.DB.prepare(`INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, price_cents, hold_expires_at)
      VALUES ('sb1', 1, 'held', 'wreath-test', 'sat', 'A', 'a@example.com', 8500, ?), ('sb2', 1, 'held', 'wreath-test', 'sat', 'B', 'b@example.com', 8500, ?)`)
      .bind(now - 1, now + 600).run();
    const { services } = testServices();
    expect(await runScheduled(env, services, new Date(now * 1000))).toEqual({
      expiredHolds: 1,
      expiredBookingHolds: 1,
      blackouts: { status: "skipped" },
      subscriptions: { status: "ok", created: 0, skippedWeeks: 0 },
      instagram: { status: "skipped" },
      outbox: { status: "skipped", delivered: 0, failed: 0 },
    });
    const s = await env.DB.prepare("SELECT id, status FROM orders WHERE id IN ('s1','s2') ORDER BY id").all<any>();
    expect(s.results).toEqual([{ id: "s1", status: "cancelled" }, { id: "s2", status: "held" }]);
    const b = await env.DB.prepare("SELECT id, status FROM bookings WHERE id IN ('sb1','sb2') ORDER BY id").all<any>();
    expect(b.results).toEqual([{ id: "sb1", status: "cancelled" }, { id: "sb2", status: "held" }]);
```

Add `await env.DB.prepare("DELETE FROM bookings").run();` to that file's `beforeEach`. In the second test, add `expect(r.expiredBookingHolds).toBe(0);` after `expect(r.expiredHolds).toBe(0);`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/routes/webhooks.test.ts tests/scheduled.test.ts`
Expected: the booking webhook tests get `applied: "ignored"`; the scheduled test's `toEqual` fails on the missing `expiredBookingHolds`.

- [ ] **Step 3: Wire the webhook**

In `src/routes/webhooks.ts`, add:

```ts
import * as bookings from "../store/bookings";
import { enqueueForBookingSessionStatements, BOOKING_PAID_KINDS } from "../store/outbox";
```
(merge the second into the existing `../store/outbox` import line).

Replace the `checkout.session.completed` block with:

```ts
    if (event.type === "checkout.session.completed") {
      // One Checkout Session is either a bouquet order or a class seat (Plan 7); try orders first.
      const order = await markPaidBySession(
        c.env.DB, event.sessionId, event.paymentIntent, event.taxCents, event.discountCents,
        enqueueForSessionStatements(c.env.DB, event.sessionId, ORDER_PAID_KINDS, nowSec),
      );
      const booking = order ? null : await bookings.markPaidBySession(
        c.env.DB, event.sessionId, event.paymentIntent, event.taxCents, event.discountCents,
        enqueueForBookingSessionStatements(c.env.DB, event.sessionId, BOOKING_PAID_KINDS, nowSec),
      );
      if (!order && !booking) console.error("webhook: completed but no held order or booking for session", event.sessionId);
      else await background(c, drainOutbox(outboxDeps, now));
      return c.json({ received: true, applied: order || booking ? "paid" : "ignored" });
    }
    if (event.type === "checkout.session.expired") {
      const did = (await cancelHeldBySession(c.env.DB, event.sessionId)) || (await bookings.cancelHeldBySession(c.env.DB, event.sessionId));
      return c.json({ received: true, applied: did ? "cancelled" : "ignored" });
    }
```

- [ ] **Step 4: Wire the scheduled job**

In `src/scheduled.ts`: add `import { expireHolds as expireBookingHolds } from "./store/bookings";`. Add to `ScheduledReport` after `expiredHolds`:

```ts
  expiredBookingHolds: number | { error: string };
```

After the `expiredHolds` try/catch add:

```ts
  let expiredBookingHolds: ScheduledReport["expiredBookingHolds"];
  try { expiredBookingHolds = await expireBookingHolds(env.DB, nowSec); }
  catch (e) { console.error("scheduled: expireBookingHolds failed", e); expiredBookingHolds = { error: msg(e) }; }
```

and return `{ expiredHolds, expiredBookingHolds, blackouts, subscriptions, instagram: instagramRes, outbox }`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/routes/webhooks.test.ts tests/scheduled.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/webhooks.ts src/scheduled.ts tests/routes/webhooks.test.ts tests/scheduled.test.ts
git commit -m "feat(webhooks): a completed session marks a booking paid when no order matches; holds expire on the tick

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Admin API and the Classes panel

**Files:**
- Create: `src/routes/admin-offers.ts`
- Modify: `src/routes/admin.ts` (register)
- Modify: `site/admin/index.html` (toolbar button, panel, script)
- Test: `tests/routes/admin-offers.test.ts`

**Interfaces:**
- Consumes: `offersOf` (Task 1); `sessionStart` (Task 2); `listForOffer`, `cancelBooking` (Task 3); `addDays`, `ymdIn` from `src/core/time.ts`.
- Produces: `registerOffersAdmin(r: App): void`, mounted from `adminRoutes()` after the Access middleware like `registerDeliveryAdmin`.
  - `GET /admin/api/offers` → `{ offers: Array<{ id, slug, name, enabled, showOnHome, priceCents, sessions: Array<{ id, date, start, seats, paidCount, heldCount, bookings: Array<{ id, customerName, customerEmail, customerPhone, note, status, createdAt }> }> }> }`. Every offer in config; sessions dated within the last 30 days or later, sorted by start; bookings of every status, oldest first.
  - `POST /admin/api/bookings/:id/cancel` → `{ ok: true }` when a held or paid booking became cancelled; `404 { error: "not found" }` otherwise.

- [ ] **Step 1: Write the failing tests**

Create `tests/routes/admin-offers.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp, asAdmin, offersConfig, WREATH, OFF_OFFER } from "../helpers";

const INSERT = `INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note, price_cents)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8500)`;
async function booking(id: string, status: string, sessionId: string, name: string, at = 1, offerId = WREATH.id) {
  await env.DB.prepare(INSERT).bind(id, at, status, offerId, sessionId, name, `${name.toLowerCase()}@example.com`, null, null).run();
}

describe("admin offers (Plan 7)", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM bookings").run(); });

  it("requires an Access identity", async () => {
    const { fetch } = testApp(undefined, offersConfig());
    expect((await fetch("/admin/api/offers")).status).toBe(401);
    expect((await fetch("/admin/api/bookings/x/cancel", { method: "POST" })).status).toBe(401);
  });

  it("lists every offer with recent-and-future sessions, counts, and the bookings", async () => {
    await booking("a1", "paid", "sat", "Jane", 1);
    await booking("a2", "held", "sat", "Bob", 2);
    await booking("a3", "cancelled", "sat", "Cat", 3);
    await booking("a4", "paid", "past", "Dan", 4);
    const { fetch } = testApp(undefined, offersConfig());
    const { offers } = await (await asAdmin(fetch)("/admin/api/offers")).json() as any;
    expect(offers.map((o: any) => [o.id, o.enabled])).toEqual([[WREATH.id, true], [OFF_OFFER.id, false]]);
    const w = offers[0];
    // "past" is 2026-09-01, inside the 30-day lookback from the 2026-09-08 test clock, so it still shows
    expect(w.sessions.map((s: any) => s.id)).toEqual(["past", "today", "sat"]);
    const sat = w.sessions[2];
    expect(sat).toMatchObject({ date: "2026-09-12", start: "18:00", seats: 2, paidCount: 1, heldCount: 1 });
    expect(sat.bookings.map((b: any) => [b.id, b.status, b.customerName])).toEqual([["a1", "paid", "Jane"], ["a2", "held", "Bob"], ["a3", "cancelled", "Cat"]]);
    expect(sat.bookings[0]).toMatchObject({ customerEmail: "jane@example.com", customerPhone: null, note: null, createdAt: 1 });
    expect(w.sessions[0].bookings.map((b: any) => b.id)).toEqual(["a4"]);
    expect(offers[1].sessions.every((s: any) => s.bookings.length === 0)).toBe(true);
  });

  it("hides sessions older than 30 days", async () => {
    const old = { ...WREATH, sessions: [{ id: "old", date: "2026-08-01", start: "18:00", seats: 8 }, ...WREATH.sessions] };
    const { fetch } = testApp(undefined, offersConfig([old]));
    const { offers } = await (await asAdmin(fetch)("/admin/api/offers")).json() as any;
    expect(offers[0].sessions.map((s: any) => s.id)).toEqual(["past", "today", "sat"]);
  });

  it("cancel frees the seat for held or paid, and is 404 for cancelled or unknown (D53)", async () => {
    await booking("c1", "paid", "sat", "Jane");
    await booking("c2", "held", "sat", "Bob");
    const { fetch } = testApp(undefined, offersConfig());
    const as = asAdmin(fetch);
    let { offers } = await (await fetch("/api/offers")).json() as any;
    expect(offers[0].sessions.find((s: any) => s.id === "sat").remaining).toBe(0);
    expect(await (await as("/admin/api/bookings/c1/cancel", { method: "POST" })).json()).toEqual({ ok: true });
    expect((await as("/admin/api/bookings/c1/cancel", { method: "POST" })).status).toBe(404);
    expect((await as("/admin/api/bookings/nope/cancel", { method: "POST" })).status).toBe(404);
    expect(await (await as("/admin/api/bookings/c2/cancel", { method: "POST" })).json()).toEqual({ ok: true });
    ({ offers } = await (await fetch("/api/offers")).json() as any);
    expect(offers[0].sessions.find((s: any) => s.id === "sat")).toMatchObject({ remaining: 2, bookable: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/routes/admin-offers.test.ts`
Expected: the list and cancel tests fail with 404.

- [ ] **Step 3: Write the admin routes**

Create `src/routes/admin-offers.ts`:

```ts
import type { App } from "../app";
import { offersOf } from "../config";
import { sessionStart } from "../core/offers";
import { addDays, ymdIn } from "../core/time";
import { cancelBooking, listForOffer } from "../store/bookings";

const LOOKBACK_DAYS = 30;

/** Plan 7 §3.8. Mounted from adminRoutes() AFTER its Access middleware, so every route here needs an identity. */
export function registerOffersAdmin(r: App): void {
  r.get("/admin/api/offers", async (c) => {
    const { config, clock } = c.get("services");
    const since = addDays(ymdIn(config.timezone, clock()), -LOOKBACK_DAYS);
    const offers = [];
    for (const o of offersOf(config)) {
      const all = await listForOffer(c.env.DB, o.id);
      const sessions = o.sessions
        .filter((s) => s.date >= since)
        .sort((a, b) => sessionStart(a, config.timezone).getTime() - sessionStart(b, config.timezone).getTime())
        .map((s) => {
          const rows = all.filter((b) => b.sessionId === s.id);
          return {
            id: s.id, date: s.date, start: s.start, seats: s.seats,
            paidCount: rows.filter((b) => b.status === "paid").length,
            heldCount: rows.filter((b) => b.status === "held").length,
            bookings: rows.map((b) => ({
              id: b.id, customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: b.customerPhone,
              note: b.note, status: b.status, createdAt: b.createdAt,
            })),
          };
        });
      offers.push({ id: o.id, slug: o.slug, name: o.name, enabled: o.enabled, showOnHome: o.showOnHome, priceCents: o.priceCents, sessions });
    }
    return c.json({ offers });
  });

  // D53: refunds happen in Stripe; this only frees the seat.
  r.post("/admin/api/bookings/:id/cancel", async (c) => {
    const did = await cancelBooking(c.env.DB, c.req.param("id"));
    if (!did) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
```

In `src/routes/admin.ts`, add `import { registerOffersAdmin } from "./admin-offers";` and, after `registerDeliveryAdmin(r);`, add `registerOffersAdmin(r);`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/routes/admin-offers.test.ts tests/routes/admin.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Add the Classes panel to `site/admin/index.html`**

Toolbar (line 52): insert `<button id="classes-btn">Classes</button>` immediately after `<button id="subs-btn">Subscribers</button>`.

Panel: insert after the Subscribers panel's closing `</div>` (the one after `<div id="subs-list"></div>`):

```html
    <div class="panel" id="classes-panel" hidden>
      <h2 style="margin:0 0 .5rem;font-size:1.1rem;font-weight:500">Classes</h2>
      <p class="status">Refund in Stripe first; "Cancel" here only frees the seat. Dates, seats and prices are edited in the site config.</p>
      <div id="classes-list"></div>
      <span class="status" id="classes-status"></span>
    </div>
```

Hide it from every other panel loader: in each of `loadDay`, `loadSubscribers`, `loadInstagram`, `loadSettings`, `loadGoogle` and `loadDelivery`, the first statement is a chain of `$('#…-panel').hidden = …;` assignments; append `$('#classes-panel').hidden = true;` to each of those six chains.

Script: add after `$('#subs-btn').addEventListener('click', loadSubscribers);`:

```js
  function hm12(s) {
    var p = s.split(':').map(Number), h = p[0] % 12 === 0 ? 12 : p[0] % 12, ap = p[0] < 12 ? 'am' : 'pm';
    return p[1] ? h + ':' + String(p[1]).padStart(2, '0') + ' ' + ap : h + ' ' + ap;
  }
  function loadClasses() {
    $('#classes-panel').hidden = false; $('#day-panel').hidden = true; $('#settings-panel').hidden = true; $('#google-panel').hidden = true; $('#subs-panel').hidden = true; $('#ig-panel').hidden = true; $('#delivery-panel').hidden = true;
    $('#classes-status').textContent = '';
    api('/offers').then(function (res) {
      var box = $('#classes-list'); box.innerHTML = '';
      if (!res.offers.length) { box.innerHTML = '<p class="status">No classes in the config.</p>'; return; }
      res.offers.forEach(function (o) {
        var block = document.createElement('div'); block.className = 'order';
        var head = document.createElement('div');
        head.innerHTML = '<strong></strong> <span class="status"></span>';
        head.querySelector('strong').textContent = o.name;
        head.querySelector('.status').textContent = (o.enabled ? 'bookable' : 'off') + (o.showOnHome ? ', on the homepage' : '') + ' · ' + money(o.priceCents) + ' a seat · /offers/' + o.slug;
        block.appendChild(head);
        if (!o.sessions.length) {
          var none = document.createElement('div'); none.className = 'status'; none.textContent = 'No upcoming dates.'; block.appendChild(none);
          box.appendChild(block); return;
        }
        o.sessions.forEach(function (s) {
          var line = document.createElement('div'); line.style.marginTop = '.5rem';
          var taken = s.paidCount + s.heldCount;
          line.innerHTML = '<div><b></b></div>';
          line.querySelector('b').textContent = human(s.date) + ', ' + hm12(s.start) + ' — ' + taken + ' of ' + s.seats + ' seats' + (s.heldCount ? ' (' + s.heldCount + ' paying now)' : '');
          s.bookings.forEach(function (b) {
            if (b.status === 'cancelled') return;
            var row = document.createElement('div'); row.className = 'row'; row.style.margin = '.2rem 0 .2rem 1rem';
            row.innerHTML = '<span class="who"></span><small class="contact"></small><small class="note"></small>';
            row.querySelector('.who').textContent = b.customerName + (b.status === 'held' ? ' (paying)' : '');
            row.querySelector('.contact').textContent = b.customerEmail + (b.customerPhone ? ' · ' + b.customerPhone : '');
            row.querySelector('.note').textContent = b.note ? 'Note: ' + b.note : '';
            if (b.status === 'paid') {
              var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Cancel';
              btn.addEventListener('click', function () {
                if (!confirm('Have you refunded ' + b.customerName + ' in Stripe? This only frees the seat.')) return;
                api('/bookings/' + b.id + '/cancel', { method: 'POST' }).then(loadClasses)
                  .catch(function (e) { if (e.message !== 'unauthorized') $('#classes-status').textContent = e.message; });
              });
              row.appendChild(btn);
            }
            line.appendChild(row);
          });
          block.appendChild(line);
        });
        box.appendChild(block);
      });
    }).catch(function (e) { if (e.message !== 'unauthorized') $('#classes-list').textContent = e.message; });
  }
  $('#classes-btn').addEventListener('click', loadClasses);
```

(`human` and `money` already exist in that script. Cancelled bookings are left out of the admin list on purpose: the count line is what Anthony needs, and a cancelled seat is already free.)

- [ ] **Step 6: Check the page by hand**

The admin API needs a Cloudflare Access token, which `npm run dev` cannot mint, so the JSON shape is proven by the tests in Step 1 and the panel is checked on the preview deploy in Task 11 (admin → Classes shows "Wreath & Sip · off · $85.00 a seat · /offers/wreath-and-sip" and the session line "Sat Nov 7, 6 pm — 0 of 8 seats"). Before committing, open `site/admin/index.html` in the browser from `npm run dev` once to confirm the page still parses (no console error on load) with the new script block in place.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: green.

```bash
git add src/routes/admin-offers.ts src/routes/admin.ts site/admin/index.html tests/routes/admin-offers.test.ts
git commit -m "feat(admin): Classes panel with headcounts per session and a cancel that frees the seat (D53)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The landing page at `/offers/<slug>`

**Files:**
- Create: `site/offers/index.html`, `site/offers/offer.css`, `site/offers/offer.js`
- Modify: `src/routes/offers.ts` (add `GET /offers/:slug`)
- Test: `tests/smoke.test.ts`, `tests/routes/offers.test.ts`

**Interfaces:**
- Consumes: `GET /api/offers` and `POST /api/book` (Task 4).
- Produces: `GET /offers/:slug` returns `site/offers/index.html` through the `ASSETS` binding for any slug (a slug containing a dot falls through to the asset router so `/offers/offer.js` keeps working in the test harness).

- [ ] **Step 1: Write the failing tests**

Append to `tests/smoke.test.ts` inside `describe("worker", …)`:

```ts
  it("serves the class landing page at /offers/<slug> for any slug (Plan 7 §3.2)", async () => {
    for (const path of ["/offers/wreath-and-sip", "/offers/anything-at-all"]) {
      const r = await SELF.fetch(`https://example.com${path}`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('id="book-form"');
      expect(body).toContain("Reserve my seat");
      expect(body).toContain("Refreshments will be provided.");
      expect(body).toContain("Hosted at Anthony's home studio in Albany. The address comes with your confirmation.");
      expect(body).toContain('src="offer.js"');
      expect(body).not.toContain("40 Manning");
    }
    expect((await SELF.fetch("https://example.com/offers/offer.js")).status).toBe(200);
  });
```

Append to `tests/routes/offers.test.ts`:

```ts
describe("GET /offers/:slug", () => {
  it("serves the one static page whatever the slug, never a 404", async () => {
    const { fetch } = testApp(undefined, offersConfig());
    for (const slug of ["wreath-test", "retired-class"]) {
      const r = await fetch(`/offers/${slug}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('id="book-form"');
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/smoke.test.ts tests/routes/offers.test.ts`
Expected: 404s.

- [ ] **Step 3: Add the route**

In `src/routes/offers.ts`, add before `return r;`:

```ts
  // One static page serves every offer; the script reads the slug from the URL (D49). An unknown or
  // retired slug still gets the page, which then says "Not currently offered": an ad link never dead-ends.
  r.get("/offers/:slug", (c) => {
    const slug = c.req.param("slug");
    if (slug.includes(".")) return c.env.ASSETS.fetch(c.req.raw); // offer.js, offer.css in the test harness
    return c.env.ASSETS.fetch(new URL("/offers/", c.req.url));
  });
```

- [ ] **Step 4: Write the stylesheet**

Create `site/offers/offer.css` (the homepage's tokens, type, button, form and pill rules, copied the way `thanks.html` carries its own):

```css
:root{
  --paper:#F6F0E5; --paper-deep:#EFE6D7; --ink:#3A2E24; --sepia:#8B7662;
  --blush:#D9A3A5; --blush-deep:#B9797C; --rule:#CDBFAD;
  --sage:#B7C4A6; --sage-deep:#6F8562; --sage-soft:#E3E8DA;
  --display:"Cormorant Garamond",Garamond,"Times New Roman",serif;
  --body:"EB Garamond",Garamond,Georgia,serif;
}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);font-size:1.125rem;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit}
a:focus-visible,button:focus-visible{outline:2px solid var(--sage-deep);outline-offset:3px}
.wrap{max-width:44rem;margin:0 auto;padding:0 1.5rem 4rem}
nav{display:flex;flex-wrap:wrap;justify-content:center;gap:.75rem 2rem;padding:1.5rem 1rem;font-family:var(--display);font-size:.95rem;letter-spacing:.22em;text-transform:uppercase}
nav a{text-decoration:none;color:var(--sepia)}
nav a:hover{color:var(--ink)}
.eyebrow{font-family:var(--display);letter-spacing:.3em;text-transform:uppercase;font-size:.8rem;color:var(--sepia);margin:2rem 0 .5rem}
h1{font-family:var(--display);font-weight:500;font-size:clamp(2rem,6vw,3.2rem);line-height:1.1;margin:0 0 .35rem;letter-spacing:.02em}
.tagline{font-size:1.2rem;font-style:italic;color:var(--sepia);margin:0 0 1.5rem}
figure{margin:0 0 1.5rem}
figure img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border:1px solid var(--rule)}
.facts{font-family:var(--display);font-size:1.2rem;margin:0 0 1rem}
.where{color:var(--sepia);font-style:italic}
fieldset{border:0;padding:0;margin:2rem 0 1rem}
legend{font-family:var(--display);font-size:1.1rem;font-weight:600;padding:0;margin-bottom:.5rem}
.sessions label{display:inline-flex;align-items:center;gap:.4rem;margin:0 .6rem .6rem 0;padding:.55rem 1rem;border:1px solid var(--rule);border-radius:999px;background:#FBF7F0;cursor:pointer;transition:background .15s,border-color .15s;position:relative}
.sessions input{position:absolute;opacity:0;width:1px;height:1px}
.sessions label:has(input:checked){border-color:var(--sage-deep);background:var(--sage);font-weight:600}
.sessions label:has(input:focus-visible){outline:2px solid var(--sage-deep);outline-offset:2px}
.sessions label.off{opacity:.45;cursor:not-allowed;text-decoration:line-through}
.form{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem 2rem}
.form label{display:flex;flex-direction:column;gap:.35rem;font-family:var(--display);font-size:1.1rem;font-weight:600;letter-spacing:.01em}
.form .opt{font-family:var(--body);font-weight:400;font-style:italic;color:var(--sepia);font-size:.95rem}
.form .full{grid-column:1/-1}
.form input,.form textarea{font:inherit;font-family:var(--body);font-size:1.05rem;font-weight:400;color:var(--ink);background:#FBF7F0;border:0;border-bottom:1px solid var(--rule);padding:.55rem .25rem}
.form input:focus,.form textarea:focus{outline:none;border-bottom-color:var(--ink);background:#EAE0CF}
.form textarea{resize:vertical}
.form-note{font-size:.95rem;color:var(--sepia);margin:.25rem 0 0}
.form-status{margin:.75rem 0 0;font-style:italic;color:var(--sepia)}
.btn{display:inline-block;margin-top:.5rem;padding:.85rem 1.9rem;border:1px solid var(--sage-deep);background:var(--sage);color:var(--ink);text-decoration:none;border-radius:999px;font-family:var(--display);letter-spacing:.2em;text-transform:uppercase;font-size:.9rem;font-weight:600;box-shadow:0 3px 0 var(--sage-deep);transition:background .2s,color .2s,transform .1s,box-shadow .1s;cursor:pointer}
.btn:hover{background:var(--sage-deep);color:var(--paper)}
.btn:active{transform:translateY(2px);box-shadow:0 1px 0 var(--sage-deep)}
.btn:disabled{opacity:.45;box-shadow:none;cursor:not-allowed}
footer{text-align:center;padding:2rem 1.5rem 3rem;font-size:.9rem;color:var(--sepia);border-top:1px solid var(--rule)}
@media (max-width:40rem){.form{grid-template-columns:1fr}}
```

- [ ] **Step 5: Write the page**

Create `site/offers/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Bull and Bloom</title>
<link rel="icon" href="/assets/logo.jpg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=EB+Garamond:ital,wght@0,400;1,400&display=swap">
<link rel="stylesheet" href="offer.css">
<script src="offer.js" defer></script>
</head>
<body>
<nav aria-label="Sections">
  <a href="/">The Bull and Bloom</a>
  <a href="/#order">Order flowers</a>
  <a href="/#contact">Contact</a>
</nav>
<main class="wrap">
  <p class="eyebrow">Current offer</p>
  <div id="loading"><p class="form-status">One moment…</p></div>

  <div id="offer" hidden>
    <h1 id="name"></h1>
    <p class="tagline" id="tagline"></p>
    <figure id="photo" hidden><img id="image" alt=""></figure>
    <p id="description"></p>
    <p class="facts" id="facts"></p>
    <p>Refreshments will be provided.</p>
    <p class="where">Hosted at Anthony's home studio in Albany. The address comes with your confirmation.</p>

    <div id="booking">
      <fieldset class="sessions" id="sessions"><legend>Pick a date</legend></fieldset>
      <form class="form" id="book-form" novalidate>
        <label>Name<input type="text" name="name" required autocomplete="name"></label>
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        <label>Phone <span class="opt">(optional)</span><input type="tel" name="phone" autocomplete="tel"></label>
        <label class="full">Anything Anthony should know? <span class="opt">(optional)</span><textarea name="note" rows="3" maxlength="500"></textarea></label>
        <div class="full">
          <button class="btn" type="submit" id="book-btn" disabled>Reserve my seat</button>
          <p class="form-note" id="total"></p>
          <p class="form-status" role="status" aria-live="polite" id="status"></p>
        </div>
      </form>
    </div>
    <p id="no-dates" class="form-status" hidden>No open dates right now. Email <a href="mailto:thebullandbloom@gmail.com">thebullandbloom@gmail.com</a> and Anthony will let you know when the next one is set.</p>
  </div>

  <div id="unavailable" hidden>
    <h1>Not currently offered</h1>
    <p>This class isn't taking bookings right now. Email <a href="mailto:thebullandbloom@gmail.com">thebullandbloom@gmail.com</a> and Anthony will let you know when the next one is set.</p>
    <p><a href="/">Back to the site</a></p>
  </div>
</main>
<footer>© 2026 The Bull and Bloom · Floral Design · thebullandbloom.com</footer>
</body>
</html>
```

- [ ] **Step 6: Write the script**

Create `site/offers/offer.js` (ES5):

```js
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var form = $('#book-form'), btn = $('#book-btn'), status = $('#status'), total = $('#total'), sessionsBox = $('#sessions');
  if (!form) return;
  var slug = location.pathname.split('/').filter(function (p) { return p; })[1] || '';
  var offer = null;

  var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function shortDate(s) { var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2])); return DAY[d.getUTCDay()] + ' ' + MON[p[1] - 1] + ' ' + p[2]; }
  function hm12(s) {
    var p = s.split(':').map(Number), h = p[0] % 12 === 0 ? 12 : p[0] % 12, ap = p[0] < 12 ? 'am' : 'pm';
    return p[1] ? h + ':' + (p[1] < 10 ? '0' : '') + p[1] + ' ' + ap : h + ' ' + ap;
  }
  function duration(m) { if (!m) return ''; if (m % 60 === 0) { var h = m / 60; return h + (h === 1 ? ' hour' : ' hours'); } return m + ' minutes'; }
  function seatsText(s) {
    if (s.bookable) return s.remaining === 1 ? '1 seat left' : s.remaining + ' seats left';
    return s.remaining === 0 ? 'Sold out' : 'Closed';
  }

  // D51: the Meta Pixel loads here and on the thanks page only, and only with an id.
  function loadPixel(id) {
    if (!id || window.fbq) return;
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', id);
    window.fbq('track', 'PageView');
  }

  function showUnavailable() {
    $('#loading').hidden = true; $('#offer').hidden = true; $('#unavailable').hidden = false;
    document.title = 'Not currently offered — The Bull and Bloom';
  }

  function chosenSession() { var f = new FormData(form); return f.get('sessionId'); }
  function refreshTotal() {
    var ok = !!(offer && chosenSession());
    total.textContent = ok ? money(offer.priceCents) + ' for one seat · tax added at checkout' : '';
    btn.disabled = !ok;
  }

  function renderSessions() {
    sessionsBox.querySelectorAll('label').forEach(function (l) { l.remove(); });
    var open = offer.sessions.filter(function (s) { return s.bookable; });
    offer.sessions.forEach(function (s, i) {
      var lab = document.createElement('label');
      if (!s.bookable) lab.className = 'off';
      lab.innerHTML = '<input type="radio" name="sessionId"><span></span>';
      var inp = lab.querySelector('input'); inp.value = s.id; inp.disabled = !s.bookable;
      inp.setAttribute('form', 'book-form');
      inp.checked = s.bookable && open[0] && open[0].id === s.id;
      lab.querySelector('span').textContent = shortDate(s.date) + ' · ' + hm12(s.start) + ' · ' + seatsText(s);
      inp.setAttribute('aria-label', shortDate(s.date) + ' at ' + hm12(s.start) + ', ' + seatsText(s));
      sessionsBox.appendChild(lab);
    });
    $('#booking').hidden = open.length === 0;
    $('#no-dates').hidden = open.length > 0;
    refreshTotal();
  }

  function render() {
    document.title = offer.name + ' — The Bull and Bloom';
    $('#name').textContent = offer.name;
    $('#tagline').textContent = offer.tagline;
    if (offer.image) { $('#image').src = '/' + offer.image; $('#image').alt = offer.imageAlt || ''; $('#photo').hidden = false; }
    $('#description').textContent = offer.description;
    var len = duration(offer.durationMinutes);
    $('#facts').textContent = money(offer.priceCents) + ' per seat' + (len ? ' · ' + len : '');
    renderSessions();
    $('#loading').hidden = true; $('#unavailable').hidden = true; $('#offer').hidden = false;
  }

  function load() {
    return fetch('/api/offers').then(function (r) { return r.json(); }).then(function (data) {
      offer = (data.offers || []).filter(function (o) { return o.slug === slug; })[0] || null;
      if (!offer) { showUnavailable(); return; }
      loadPixel(data.marketing && data.marketing.metaPixelId);
      render();
    }).catch(function () {
      $('#loading').hidden = true;
      status.textContent = 'The page is briefly unavailable. Email thebullandbloom@gmail.com to book.';
    });
  }

  sessionsBox.addEventListener('change', refreshTotal);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(form);
    if (!chosenSession()) { status.textContent = 'Pick a date.'; return; }
    if (!form.reportValidity()) return;
    btn.disabled = true; status.textContent = 'One moment…';
    fetch('/api/book', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offerId: offer.id, sessionId: chosenSession(),
        customer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
        note: f.get('note') || undefined
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.ok) { window.location.href = r.body.url; return; }
        btn.disabled = false;
        var err = r.body && r.body.error;
        if (err === 'sold_out') { status.textContent = 'That date just filled up — pick another.'; load(); }
        else if (err === 'closed') { status.textContent = 'Bookings for that date have closed. Pick another.'; load(); }
        else if (err === 'disabled') { showUnavailable(); }
        else if (r.status === 503) { status.textContent = 'Payments are down, try again in a minute.'; }
        else { status.textContent = err || 'Something went wrong.'; }
      })
      .catch(function () { btn.disabled = false; status.textContent = 'Something went wrong. Try again.'; });
  });

  load();
})();
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run tests/smoke.test.ts tests/routes/offers.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 8: Check the page by hand**

Run `npm run dev`. Open `http://localhost:8787/offers/wreath-and-sip`: with the repo config (offer off) it reads "Not currently offered". Temporarily set `"enabled": true` in `store.config.json` (do not commit), restart, reload: the name, tagline, description, "$85 per seat · 2 hours", the two D50 lines, one date pill "Sat Nov 7 · 6 pm · 8 seats left", the form, and the total "$85 for one seat · tax added at checkout" once a date is chosen. Open `http://localhost:8787/offers/nothing-here`: "Not currently offered". Revert the config.

- [ ] **Step 9: Commit**

```bash
git add site/offers/index.html site/offers/offer.css site/offers/offer.js src/routes/offers.ts tests/smoke.test.ts tests/routes/offers.test.ts
git commit -m "feat(site): class landing page at /offers/<slug> with seats, booking form and the Meta Pixel (D49, D50, D51)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Homepage teaser and nav link

**Files:**
- Modify: `site/index.html` (nav, a new section between `#order` and `#about`, a few CSS rules)
- Modify: `site/store.js` (`load()` and a new `renderOffers`)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: `GET /api/offers` (Task 4): `offers[].showOnHome`, `sessions[].bookable`, `remaining`, `date`, `start`, `slug`, `image`, `imageAlt`, `name`, `tagline`.
- Produces: `<section id="offers" hidden>` with `<div id="offer-cards">`, and `<a href="#offers" id="nav-offers" hidden>Offers</a>` in the nav. Both are shown only when at least one card renders. The pixel is never loaded here (D51).

- [ ] **Step 1: Write the failing test**

Append to `tests/smoke.test.ts` inside `describe("worker", …)`:

```ts
  it("carries the Current offers teaser and its nav link, both hidden until a bookable offer renders (Plan 7 §3.3)", async () => {
    const body = await (await SELF.fetch("https://example.com/")).text();
    expect(body).toMatch(/<section id="offers" hidden>/);
    expect(body).toMatch(/<a href="#offers" id="nav-offers" hidden>Offers<\/a>/);
    expect(body).toContain('id="offer-cards"');
    expect(body).toContain("Current offers");
    expect(body).not.toContain("connect.facebook.net");
    const js = await (await SELF.fetch("https://example.com/store.js")).text();
    expect(js).toContain("fetch('/api/offers')");
    expect(js).not.toContain("fbq");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: the new test fails on the missing section.

- [ ] **Step 3: Edit the homepage**

Nav (`site/index.html` lines 187–191): insert `<a href="#offers" id="nav-offers" hidden>Offers</a>` between the Order and About links.

CSS: add after the `.plan-price span{…}` rule:

```css
  /* current offers (Plan 7) */
  .offer-cards{display:grid;gap:2rem}
  .offer-card{display:grid;grid-template-columns:minmax(0,1fr) 1.4fr;gap:2rem;align-items:center;border:1px solid var(--ink);background:var(--paper-deep);padding:1.5rem}
  .offer-card img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}
  .offer-card h3{font-family:var(--display);font-weight:600;font-size:1.7rem;margin:0 0 .3rem}
  .offer-card p{margin:0 0 .6rem}
  .offer-card .next{font-family:var(--display);font-size:1.15rem;color:var(--sepia)}
  .offer-card .btn{margin-top:.75rem}
  @media (max-width:40rem){.offer-card{grid-template-columns:1fr}}
```

Section: insert between the closing `</section>` of `#order` and `<section id="about">`:

```html
  <section id="offers" hidden>
    <p class="eyebrow">At the studio</p>
    <h2>Current offers</h2>
    <div class="offer-cards" id="offer-cards"></div>
  </section>
```

- [ ] **Step 4: Render the cards in `site/store.js`**

Add after `renderGallery` (before the tabs block):

```js
  // ---- current offers (Plan 7 §3.3): a teaser card per offer that is on the homepage and has a bookable date.
  var SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var SHORT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(s) { var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2])); return SHORT_DAY[d.getUTCDay()] + ' ' + SHORT_MON[p[1] - 1] + ' ' + p[2]; }
  function hm12(s) {
    var p = s.split(':').map(Number), h = p[0] % 12 === 0 ? 12 : p[0] % 12, ap = p[0] < 12 ? 'am' : 'pm';
    return p[1] ? h + ':' + (p[1] < 10 ? '0' : '') + p[1] + ' ' + ap : h + ' ' + ap;
  }
  function renderOffers(data) {
    var section = $('#offers'), cards = $('#offer-cards'), navLink = $('#nav-offers');
    if (!section || !cards || !data || !data.offers) return;
    cards.innerHTML = '';
    data.offers.forEach(function (o) {
      if (!o.showOnHome) return;
      var next = o.sessions.filter(function (s) { return s.bookable; })[0];
      if (!next) return;
      var card = document.createElement('article'); card.className = 'offer-card';
      card.innerHTML = '<img alt=""><div><h3></h3><p class="tag"></p><p class="next"></p><a class="btn"></a></div>';
      var img = card.querySelector('img'); img.src = o.image; img.alt = o.imageAlt || '';
      card.querySelector('h3').textContent = o.name;
      card.querySelector('.tag').textContent = o.tagline;
      card.querySelector('.next').textContent = 'Next: ' + shortDate(next.date) + ' · ' + hm12(next.start) + ' · ' + (next.remaining === 1 ? '1 seat left' : next.remaining + ' seats left');
      var a = card.querySelector('a'); a.href = '/offers/' + o.slug; a.textContent = 'Book a seat';
      cards.appendChild(card);
    });
    var any = cards.children.length > 0;
    section.hidden = !any;
    if (navLink) navLink.hidden = !any;
  }
```

In `load()`, add after the `/api/feed` line:

```js
    fetch('/api/offers').then(function (r) { return r.json(); }).then(renderOffers).catch(function () {});
```

(`o.image` is `assets/wreath.jpg`, relative, which resolves correctly from `/`. The landing page prefixes `/` because it lives under `/offers/`.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS.

- [ ] **Step 6: Check by hand**

`npm run dev`, open `http://localhost:8787/`: no Offers link, no section. Temporarily set `"enabled": true, "showOnHome": true` in `store.config.json`, restart: the nav shows Offers, the section shows the card with "Next: Sat Nov 7 · 6 pm · 8 seats left" and a "Book a seat" button that lands on `/offers/wreath-and-sip` (a broken image until `assets/wreath.jpg` exists, Task 11). Revert the config.

- [ ] **Step 7: Commit**

```bash
git add site/index.html site/store.js tests/smoke.test.ts
git commit -m "feat(site): Current offers teaser and nav link, shown only when a seat can be booked (D49)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Thanks page variant with the Purchase pixel, privacy page, README

**Files:**
- Modify: `site/thanks.html`
- Modify: `site/privacy.html`
- Modify: `README.md:8` and the Deploy section
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: `/thanks?booking=<id>&offer=<offerId>` (the success URL from Task 4) and `GET /api/offers` for the price and pixel id.
- Produces: the third thanks variant; `Purchase` event with `{ value: priceCents / 100, currency: "USD" }` when the pixel id is set and the offer is found.

- [ ] **Step 1: Write the failing tests**

Append to `tests/smoke.test.ts` inside `describe("worker", …)`:

```ts
  it("thanks page carries the booking variant and fires Purchase only through the pixel loader (Plan 7 §3.4, §3.9)", async () => {
    const body = await (await SELF.fetch("https://example.com/thanks")).text();
    expect(body).toContain("Your seat is saved. The details, including where to come, are in the email on its way to you.");
    expect(body).toContain("[?&]booking=");
    expect(body).toContain("fbq('track', 'Purchase'");
    expect(body).toContain("currency: 'USD'");
  });
  it("privacy page names the pixel on the class and thank-you pages only (Plan 7 §3.9)", async () => {
    const body = await (await SELF.fetch("https://example.com/privacy")).text();
    expect(body).not.toContain("There are no advertising trackers on this site");
    expect(body).toContain("Meta Pixel");
    expect(body).toContain("facebook.com/privacy/policy");
    expect(body).toContain("Last updated: October 2, 2026");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/smoke.test.ts`
Expected: both new tests fail.

- [ ] **Step 3: Edit the thanks page**

Replace the `<script>` block in `site/thanks.html` with:

```html
  <script>
    (function () {
      var q = location.search, msg = document.getElementById('msg');
      var booking = /[?&]booking=([^&]+)/.exec(q), offerId = /[?&]offer=([^&]+)/.exec(q);
      if (/[?&]subscription=1/.test(q)) {
        msg.textContent = "Your subscription is set. Your first bouquet's date, and the link to cancel or change your card, are in the email on its way to you.";
        return;
      }
      if (!booking) return;
      msg.textContent = "Your seat is saved. The details, including where to come, are in the email on its way to you.";
      // D51: the Meta Pixel loads on this page only for a class booking, and only with an id. Nothing here affects the booking.
      fetch('/api/offers').then(function (r) { return r.json(); }).then(function (data) {
        var id = data.marketing && data.marketing.metaPixelId;
        var offer = offerId ? (data.offers || []).filter(function (o) { return o.id === decodeURIComponent(offerId[1]); })[0] : null;
        if (!id || !offer || window.fbq) return;
        !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
        window.fbq('init', id);
        window.fbq('track', 'PageView');
        window.fbq('track', 'Purchase', { value: offer.priceCents / 100, currency: 'USD' });
      }).catch(function () {});
    })();
  </script>
```

- [ ] **Step 4: Edit the privacy page**

In `site/privacy.html`, replace the "What we don't do" paragraph with:

```html
  <p>We don't sell or share your information with anyone. We won't send you marketing email unless you ask us to.</p>
  <p>The class pages (the ones under <code>/offers</code>) and the thank-you page use the Meta Pixel so we can measure ads we run on Facebook and Instagram; the rest of the site does not. Meta's own policy covers what the pixel collects: <a href="https://www.facebook.com/privacy/policy">facebook.com/privacy/policy</a>.</p>
```

Change the "Last updated" line to `<p class="updated">Last updated: October 2, 2026</p>` (and to the real deploy date in Task 11 if it slips to another day; the smoke test asserts the string, so update both together).

- [ ] **Step 5: Update the README**

Line 8 becomes:

```md
- `store.config.json` — menu, prices, subscription grid (cadences × sizes, monthly price per cell), capacity defaults, studio address/phone/ready time, delivery zones (name, fee, ZIPs) and mode, classes sold by the seat (`offers`: name, copy, photo, price, sessions with seats, `enabled` / `showOnHome` switches, booking cutoff) and the Meta Pixel id (`marketing.metaPixelId`, empty = no pixel).
```

Add a paragraph at the end of the Deploy section:

```md
Classes (Plan 7): each offer in `store.config.json` has a landing page at `/offers/<slug>` (the address to put in an ad) and, with `showOnHome`, a card on the homepage. Adding a date, changing seats or price, or retiring an offer is a config edit and a deploy. Seats are counted in D1 (`bookings`); the Stripe webhook marks a seat paid and queues the confirmation emails through the outbox. Refund in Stripe, then cancel the booking in admin → Classes to free the seat. The photo lives at `site/assets/<name>.jpg` and is named by the offer's `image`.
```

- [ ] **Step 6: Run the tests and commit**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS.

```bash
git add site/thanks.html site/privacy.html README.md tests/smoke.test.ts
git commit -m "feat(site): thanks page knows a booked seat and fires Purchase; privacy names the pixel; README (D51)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Fill the blanks and verify live (lead)

This task is Ryan's with the lead. Nothing here is automated; each line is a check or an edit.

- [ ] **Fill §6 of the spec in `store.config.json`:** seat price, seats per session, the real dates and start times (one session object per date, `id` like `2026-11-07-1800`), `durationMinutes`, `bookingClosesHoursBefore`, `description` and `imageAlt`. Keep `enabled` and `showOnHome` false for this commit. Run `npx vitest run tests/config.test.ts`.
- [ ] **Photo:** save Anthony's wreath photo as `site/assets/wreath.jpg` (JPEG, 4:3, around 1600px wide, under 400 KB). Commit with the config: `config(offers): Wreath & Sip dates, seats and price` and the Co-Authored-By line.
- [ ] **Customer email wording and cancellation terms:** edit the lines in `bookingConfirmedEmail` (`src/core/booking-messages.ts`) and the matching assertions in `tests/core/booking-messages.test.ts` and `tests/jobs/outbox.test.ts`. The D50 sentences stay. Commit `copy(offers): confirmation email wording approved by Anthony`.
- [ ] **Stripe tax code:** if Ryan picks a code other than `txcd_99999999` for the seat, change `TAX_CODES.workshop` in `src/adapters/stripe.ts` and the assertion in `tests/adapters/stripe.test.ts`.
- [ ] **Pixel id:** set `marketing.metaPixelId` when Anthony has the pixel; leave empty otherwise.
- [ ] **Merge** `plan7/*` into `claude/staging-review-bull-bloom-f8x3sw`; `npx vitest run && npx tsc --noEmit` green; Ryan merges to main. The deploy applies `0008_bookings.sql`.
- [ ] **Preview run with the offer off:** `curl -s https://thebullandbloom.com/api/offers` is `{"offers":[],"marketing":{"metaPixelId":""}}`; `https://thebullandbloom.com/offers/wreath-and-sip` says "Not currently offered"; the homepage shows no Offers link.
- [ ] **Switch on:** set `enabled: true` (and `showOnHome: true` when the ad goes live), commit `config(offers): Wreath & Sip on sale`, deploy. Then: the homepage shows the card with "Next: …"; the landing page shows every date with seats; booking a seat with a Stripe test card (or a 100% promotion code in live mode) lands on `/thanks?booking=…&offer=…` with "Your seat is saved…"; the customer email and Anthony's headcount email arrive; admin → Classes shows "1 of N seats" with the name; cancel in admin shows "0 of N" and the landing page shows the seat back.
- [ ] **Cutoff check:** the night before the first date at the cutoff hour, the date pill reads "Closed" (D54).
- [ ] **After the run:** `showOnHome: false` while the ad finishes, then `enabled: false`; the landing page reads "Not currently offered".

