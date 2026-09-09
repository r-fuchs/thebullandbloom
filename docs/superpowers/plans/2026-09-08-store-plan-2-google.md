# Store Plan 2: Google calendars and email (blackouts, order events, confirmations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anthony learns of every paid order without opening admin: it lands on his phone calendar and in his Gmail, the customer gets a confirmation, and any event he puts on a "Bull and Bloom: Closed" calendar takes that day off the market.

**Architecture:** One Google OAuth grant (Calendar + Gmail send), authorized once from the admin page, stored encrypted in D1. A `Google` adapter interface with a fake for tests and a real `fetch`-based implementation (no Google SDK). Blackout sync runs on the existing 15-minute cron and writes `source='calendar'` rows into `day_overrides`, which Plan 1's `getOverrides` already merges. Calendar events and emails for a paid order go through an `outbox` table: the Stripe webhook enqueues three rows atomically with the status flip, tries to deliver them immediately in the background, and the cron retries failures with backoff.

**Tech Stack:** Cloudflare Workers, D1, Hono, TypeScript, Google Calendar API v3 and Gmail API v1 over `fetch`, Web Crypto (AES-GCM), Vitest with `@cloudflare/vitest-pool-workers`, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-07-store-design.md`. This plan implements §2 items 3 (calendar blackouts), 9 (Orders calendar), 10 (email); §4.4 "Blackout sync" and the calendar/email side effects of "Stripe webhook"; §4.5 rows for Google Calendar and Gmail; §5 `adapters/google` and the Google parts of `routes/admin` and `cron`; §7 item 3. Plans 3–5 cover Uber, subscriptions, Instagram. DNS cutover is NOT in this plan; it follows Plan 2 per Plan 1 Task 15.

**Delegation (MeOS convention, applies here too):** Tasks 1–11 are exact-spec builds with a verifiable finish line: `model: "sonnet"`. Task 12 is credentialed setup and acceptance and stays in the main session with Ryan. Every Agent call passes `model` explicitly.

## Global Constraints

- Timezone for all date math: `America/New_York` (spec §4.2). Dates are `YYYY-MM-DD` strings everywhere; never a JS `Date` for a calendar day. Timed Google events are converted to studio-local dates with `ymdIn(tz, …)` from `src/core/time.ts`.
- Money is integer cents everywhere. Never floats. Display through `dollars(cents)` (Task 7).
- Order truth stays in D1 (spec D4). Calendars are a view (Orders) and a blackout input (Closed). Nothing in this plan reads the Orders calendar back or lets a calendar edit change an order.
- Admin-sourced overrides are never touched by calendar sync (spec §4.4): every write in `syncCalendarOverrides` is scoped `source = 'calendar'`.
- On Google failure: blackouts keep the last synced state and log; order events and emails queue and retry (spec §4.5). No Google failure may turn a paid order into anything else or make the webhook return non-2xx.
- Secrets never in the repo: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` come from Wrangler secrets (spec §4.7). They are OPTIONAL bindings: the Worker serves without them and admin reports "not configured". The refresh token is not a Wrangler secret; it is stored AES-GCM encrypted in D1 `settings` (decision D18, recorded in this plan and to be added to spec §3 in Task 12).
- Core modules (`src/core/*`) import nothing from `src/adapters`, `src/store`, `src/jobs`, or Hono. Type-only imports from `src/adapters/google.ts` and `src/store/orders.ts` are the one allowance, matching Plan 1's `core/capacity` ↔ `store/overrides` type sharing.
- Every task ends with `npm test` and `npm run typecheck` green and a commit on branch `feat/store`.
- Storefront and admin page stay plain HTML/CSS/JS, ES5 style as in Plan 1, no build step.
- Email is plain text only (`text/plain; charset=utf-8`). No HTML mail in v1.
- Google API calls use `fetch` directly. No `googleapis` npm package (it does not run in Workers and would triple the bundle).

## Decisions made while planning (engineering internals; Ryan can veto any)

| # | Decision | Alternatives | Why |
|---|---|---|---|
| D18 | The Google refresh token lives in D1 `settings` under key `google.token`, AES-GCM encrypted with a key derived from `ADMIN_SECRET`. | Wrangler secret; plaintext in D1 | A Worker cannot write Wrangler secrets at runtime, so a secret would force Ryan to copy a token by hand after Anthony's one-click connect. Encryption means a D1 dump alone cannot send mail as Anthony. Rotating `ADMIN_SECRET` requires reconnecting Google (visible in admin as "not connected"). |
| D19 | The two calendars are created by the store when Anthony connects: find by name in his calendar list, else create. Ids are stored in `settings` key `google.state`. | Anthony creates them by hand; ids pasted into config | Removes two manual steps and a config edit (spec §1's test). Renaming a calendar in Google does not break anything because the id is what is stored. |
| D20 | Order side effects (calendar event, customer email, owner email) go through an `outbox` table. Rows are inserted in the same D1 batch as the `paid` flip, drained immediately in the background, then by the 15-minute cron with exponential backoff (2, 4, 8 … 64 min, capped) up to 24 attempts (~22 h), after which the row is "failed" and admin shows it with a Retry button. | Fire-and-forget from the webhook; a separate queue product | Spec §4.5 requires queue-and-retry for both Google dependencies. A table is the only queue that costs nothing and is visible in admin. Same-batch insert means a paid order can never exist without its three delivery rows. |
| D21 | The Orders-calendar event id is derived from the order id (`bb` + the UUID without hyphens), and a 409 from Google on insert counts as success. | Let Google assign ids | A retry after a timeout cannot create a duplicate event. |
| D22 | The OAuth consent screen is published "In production" without Google verification. Anthony sees Google's "unverified app" interstitial once and clicks through. | "Testing" status | Testing-status refresh tokens expire after 7 days, which would silently stop calendar and email weekly. Verification is a multi-day review that can be filed later if the interstitial proves unacceptable. Task 12 checks this on the real consent flow. |
| D23 | Anthony's copy of each order goes to `store.config.json` `studio.ownerEmail`, defaulting to the store Gmail itself. | Separate notification address | Gmail delivers self-sent mail normally, and the store account is the one he authorized. Changing it is a config edit. |
| D24 | Order events are all-day events on the order date with size, name, and fulfillment in the title. | Timed event at a ready time | The phone's day view lists all-day items at the top as a checklist. A studio ready time does not exist in config until Plan 3 (courier pickup). |
| D25 | The OAuth callback is authenticated by a signed, 10-minute `state` parameter (HMAC with a key derived from `ADMIN_SECRET`), not by the admin cookie. | Cookie only | The admin cookie is `SameSite=Strict`, and a redirect back from accounts.google.com is a cross-site top-level navigation, so the browser withholds the cookie. |

## Decisions Ryan made (2026-09-08, before execution)

1. **Google Cloud project and OAuth client owner:** Ryan's own Google account.
2. **Who clicks "Connect Google":** Anthony, signed in as thebullandbloom@gmail.com (Ryan walks him through it).
3. **Email copy:** the Task 7 drafts stand for the build; Ryan will have Anthony review them when needed, and any change is a template + test edit.
4. **Event title shape** (D24): "Bouquet · Pat Smith · pickup" approved.

---

## File structure

```
migrations/0002_outbox.sql        outbox table (D20)
store.config.json                 + studio.ownerEmail, calendars.{closed,orders} names
src/
  env.ts                          + GOOGLE_CLIENT_ID?, GOOGLE_CLIENT_SECRET?
  config.ts                       + ownerEmail, calendars in StoreConfig + validation
  app.ts                          Services += google
  index.ts                        servicesFor(env) shared by fetch and scheduled
  scheduled.ts                    orchestrates expireHolds, syncBlackouts, drainOutbox
  adapters/google.ts              Google interface + types + GoogleNotConnected
  adapters/google-api.ts          GoogleApi (real): OAuth, Calendar v3, Gmail v1 over fetch
  store/google.ts                 encrypted token + connection state + last-sync (settings keys google.*)
  store/overrides.ts              + syncCalendarOverrides
  store/orders.ts                 + calendarEventId column, setCalendarEventId, markPaidBySession extras
  store/outbox.ts                 enqueue / due / done / failed / counts / retry / backoff
  core/time.ts                    + humanDate (moved from routes/public), longDate
  core/blackouts.ts               closedDatesFromEvents (pure)
  core/messages.ts                orderEvent, customerEmail, ownerEmail, dollars (pure)
  jobs/blackouts.ts               syncBlackouts
  jobs/outbox.ts                  drainOutbox
  routes/background.ts            waitUntil-or-await helper
  routes/webhooks.ts              enqueue on paid, kick drain
  routes/admin.ts                 calls registerGoogleAdmin(r)
  routes/admin-google.ts          /admin/api/google/* and /admin/google/callback
site/admin/index.html             Google panel; #YYYY-MM-DD deep link
scripts/google-setup.sh           secrets from .dev.vars, remote migration, preview redeploy
tests/
  fakes/google.ts                 FakeGoogle
  helpers.ts                      testApp returns google; seedGoogleConnection; clearGoogle
  adapters/google-api.test.ts core/blackouts.test.ts core/messages.test.ts
  store/google.test.ts store/outbox.test.ts store/overrides.test.ts (+)
  jobs/blackouts.test.ts jobs/outbox.test.ts
  routes/admin-google.test.ts routes/webhooks.test.ts (+) scheduled.test.ts (~)
```

---

### Task 1: Google adapter interface, fake, and service wiring

**Files:**
- Create: `src/adapters/google.ts`, `tests/fakes/google.ts`
- Modify: `src/env.ts`, `src/app.ts`, `src/index.ts`, `tests/helpers.ts`, `tests/setup.ts`, `vitest.config.ts`, `src/scheduled.ts`, `tests/scheduled.test.ts`
- Test: `tests/smoke.test.ts` (existing, must still pass), `tests/index.test.ts` (existing)

**Interfaces:**
- Produces: `Google`, `CalendarEvent`, `NewAllDayEvent`, `Mail`, `Connection`, `GoogleNotConnected` (all `src/adapters/google.ts`); `Services.google: Google`; `servicesFor(env): Services` in `src/index.ts`; `FakeGoogle` in `tests/fakes/google.ts`; `testApp()` now returns `{ app, payments, google, fetch }`.
- Note: `src/adapters/google-api.ts` (the real adapter) is Task 3. Until then `servicesFor` uses a stub described in Step 4 so the Worker builds; Task 3 replaces the stub.

- [ ] **Step 1: Write the interface**

`src/adapters/google.ts`:

```ts
// Google Calendar + Gmail behind one interface. Core and jobs depend on this file only;
// the real implementation (google-api.ts) and the test fake both satisfy it.

export interface CalendarEvent {
  id: string;
  status?: string; // "confirmed" | "tentative" | "cancelled"
  summary?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
}
export interface NewAllDayEvent { id: string; date: string; summary: string; description: string }
export interface Mail { to: string; subject: string; text: string }
export interface Connection { refreshToken: string; account: string }

export class GoogleNotConnected extends Error {
  constructor() { super("google: not connected"); this.name = "GoogleNotConnected"; }
}

export interface Google {
  /** true when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set */
  configured(): boolean;
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<Connection>;
  listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
  /** find a calendar by exact name in the connected account, else create it; returns its id */
  ensureCalendar(summary: string, timeZone: string): Promise<string>;
  /** returns the event id; an event that already exists with this id counts as success (D21) */
  insertAllDayEvent(calendarId: string, event: NewAllDayEvent): Promise<string>;
  sendMail(mail: Mail): Promise<void>;
}
```

- [ ] **Step 2: Write the fake**

`tests/fakes/google.ts`:

```ts
import type { CalendarEvent, Connection, Google, Mail, NewAllDayEvent } from "../../src/adapters/google";

export class FakeGoogle implements Google {
  isConfigured = true;
  /** calendar name -> id, as ensureCalendar would find them */
  calendars = new Map<string, string>();
  /** calendar id -> events returned by listEvents */
  events: Record<string, CalendarEvent[]> = {};
  inserted: Array<{ calendarId: string; event: NewAllDayEvent }> = [];
  sent: Mail[] = [];
  /** when set, the next API call throws this message once */
  failNext: string | null = null;

  configured() { return this.isConfigured; }
  authUrl(state: string, redirectUri: string) {
    return `https://accounts.google.test/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(code: string): Promise<Connection> {
    this.maybeFail();
    if (code !== "good-code") throw new Error("invalid_grant");
    return { refreshToken: "rt_fake", account: "thebullandbloom@gmail.com" };
  }
  async listEvents(calendarId: string) { this.maybeFail(); return this.events[calendarId] ?? []; }
  async ensureCalendar(summary: string) {
    this.maybeFail();
    let id = this.calendars.get(summary);
    if (!id) { id = `cal_${this.calendars.size + 1}`; this.calendars.set(summary, id); }
    return id;
  }
  async insertAllDayEvent(calendarId: string, event: NewAllDayEvent) {
    this.maybeFail();
    this.inserted.push({ calendarId, event });
    return event.id;
  }
  async sendMail(mail: Mail) { this.maybeFail(); this.sent.push(mail); }

  private maybeFail() {
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
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
}
```

In `tests/setup.ts` add the same two optional lines to the `Cloudflare.Env` declaration. In `vitest.config.ts` add to `miniflare.bindings`:

```ts
            GOOGLE_CLIENT_ID: "test-client-id",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
```

- [x] **Step 4: Wire `google` into Services and build services once**

`src/app.ts`: change the `Services` line and its import:

```ts
import type { Google } from "./adapters/google";
// ...
export interface Services { payments: Payments; google: Google; clock: () => Date; config: StoreConfig }
```

`src/index.ts` becomes:

```ts
import type { Env } from "./env";
import { buildApp, type Services } from "./app";
import { loadConfig } from "./config";
import { StripePayments } from "./adapters/stripe";
import { GoogleApi } from "./adapters/google-api";
import { connectionSource } from "./store/google";
import { runScheduled } from "./scheduled";

let services: Services | null = null;
let app: ReturnType<typeof buildApp> | null = null;

export function servicesFor(env: Env): Services {
  if (!services) {
    const payments = new StripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
    const google = new GoogleApi(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, connectionSource(env.DB, env.ADMIN_SECRET));
    services = { payments, google, clock: () => new Date(), config: loadConfig() };
  }
  return services;
}

function appFor(env: Env) {
  if (!app) app = buildApp(servicesFor(env));
  return app;
}

const REQUIRED_SECRETS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "ADMIN_PASSCODE", "ADMIN_SECRET"] as const;

function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((k) => typeof env[k] !== "string" || env[k] === "");
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const missing = missingSecrets(env);
    if (missing.length > 0) {
      console.error("misconfigured: missing", missing.join(", "));
      return new Response("misconfigured", { status: 500 });
    }
    return appFor(env).fetch(req, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduled(env, servicesFor(env), new Date())
        .then((r) => console.log("scheduled", JSON.stringify(r)))
        .catch((e) => console.error("scheduled failed", e)),
    );
  },
};
```

`GoogleApi` and `connectionSource` do not exist yet. So that this task compiles on its own, create TEMPORARY stubs that Tasks 2 and 3 replace with the real modules:

`src/store/google.ts` (temporary, replaced in Task 2):

```ts
import type { Connection } from "../adapters/google";
export interface ConnectionSource { load(): Promise<Connection | null> }
export function connectionSource(_db: D1Database, _secret: string): ConnectionSource {
  return { load: async () => null };
}
```

`src/adapters/google-api.ts` (temporary, replaced in Task 3):

```ts
import { GoogleNotConnected, type Google } from "./google";
import type { ConnectionSource } from "../store/google";
export class GoogleApi implements Google {
  constructor(private clientId: string | undefined, private clientSecret: string | undefined, private source: ConnectionSource) {}
  configured() { return Boolean(this.clientId && this.clientSecret); }
  authUrl(): string { throw new GoogleNotConnected(); }
  async exchangeCode(): Promise<never> { throw new GoogleNotConnected(); }
  async listEvents(): Promise<never> { throw new GoogleNotConnected(); }
  async ensureCalendar(): Promise<never> { throw new GoogleNotConnected(); }
  async insertAllDayEvent(): Promise<never> { throw new GoogleNotConnected(); }
  async sendMail(): Promise<never> { throw new GoogleNotConnected(); }
}
```

`src/scheduled.ts` takes services now (behavior unchanged until Task 9):

```ts
import type { Env } from "./env";
import type { Services } from "./app";
import { expireHolds } from "./store/orders";

export interface ScheduledReport { expiredHolds: number }

export async function runScheduled(env: Env, _services: Services, now: Date): Promise<ScheduledReport> {
  const expiredHolds = await expireHolds(env.DB, Math.floor(now.getTime() / 1000));
  return { expiredHolds };
}
```

- [ ] **Step 5: Update the test helpers**

`tests/helpers.ts`: add the import and change `testApp`:

```ts
import { FakeGoogle } from "./fakes/google";
// ...
export function testApp(now = new Date("2026-09-08T14:00:00Z")) {
  const payments = new RecordingPayments();
  const google = new FakeGoogle();
  const app = buildApp({ payments, google, clock: () => now, config: loadConfig() });
  const fetch = (path: string, init?: RequestInit) =>
    app.request(new Request(`https://example.com${path}`, init), undefined, env);
  return { app, payments, google, fetch };
}

/** Services object for jobs and runScheduled tests, sharing testApp's fakes. */
export function testServices(now = new Date("2026-09-08T14:00:00Z")) {
  const payments = new RecordingPayments();
  const google = new FakeGoogle();
  return { services: { payments, google, clock: () => now, config: loadConfig() }, payments, google };
}
```

`tests/scheduled.test.ts`: change the call to

```ts
import { testServices } from "./helpers";
// ...
    const { services } = testServices();
    expect(await runScheduled(env, services, new Date(now * 1000))).toEqual({ expiredHolds: 1 });
```

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all 75 existing tests pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/google.ts src/adapters/google-api.ts src/store/google.ts src/env.ts src/app.ts src/index.ts src/scheduled.ts tests/fakes/google.ts tests/helpers.ts tests/setup.ts tests/scheduled.test.ts vitest.config.ts
git commit -m "feat(google): adapter interface, fake, and service wiring"
```

---

### Task 2: Encrypted connection store and connection state

**Files:**
- Replace: `src/store/google.ts` (the Task 1 stub)
- Test: `tests/store/google.test.ts`

**Interfaces:**
- Consumes: `Connection` from Task 1.
- Produces (all in `src/store/google.ts`):
  - `interface ConnectionSource { load(): Promise<Connection | null> }`
  - `connectionSource(db, secret): ConnectionSource`
  - `interface GoogleState { account: string; closedCalendarId: string; ordersCalendarId: string; connectedAt: number }`
  - `saveConnection(db, secret, conn: Connection): Promise<void>` (encrypts)
  - `loadConnection(db, secret): Promise<Connection | null>` (null when absent or undecryptable, logs the latter)
  - `saveState(db, state: GoogleState)`, `loadState(db): Promise<GoogleState | null>`
  - `clearConnection(db)` (deletes token, state, and sync keys)
  - `recordSync(db, at: number, error: string | null)`, `loadSync(db): Promise<{ at: number | null; error: string | null }>`
  - `encrypt(secret, plain): Promise<string>`, `decrypt(secret, packed): Promise<string>` (exported for tests)
- Settings keys used: `google.token`, `google.state`, `google.sync`. `store/settings.ts` ignores them (it filters to `cap`, `cutoff`, `openWeekdays`).

- [ ] **Step 1: Write the failing tests**

`tests/store/google.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  encrypt, decrypt, saveConnection, loadConnection, saveState, loadState, clearConnection,
  recordSync, loadSync, connectionSource,
} from "../../src/store/google";

const SECRET = "test-secret";

describe("store/google", () => {
  beforeEach(async () => { await clearConnection(env.DB); });

  it("encrypts and decrypts, with a fresh iv each time", async () => {
    const a = await encrypt(SECRET, "hello");
    const b = await encrypt(SECRET, "hello");
    expect(a).not.toBe(b);
    expect(a).not.toContain("hello");
    expect(await decrypt(SECRET, a)).toBe("hello");
    await expect(decrypt("other-secret", a)).rejects.toThrow();
  });

  it("stores the connection encrypted and reads it back", async () => {
    await saveConnection(env.DB, SECRET, { refreshToken: "rt_secret_value", account: "thebullandbloom@gmail.com" });
    const raw = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'google.token'").first<{ value_json: string }>();
    expect(raw!.value_json).not.toContain("rt_secret_value");
    expect(await loadConnection(env.DB, SECRET)).toEqual({ refreshToken: "rt_secret_value", account: "thebullandbloom@gmail.com" });
    expect(await connectionSource(env.DB, SECRET).load()).toEqual({ refreshToken: "rt_secret_value", account: "thebullandbloom@gmail.com" });
  });

  it("returns null when absent or when the secret changed", async () => {
    expect(await loadConnection(env.DB, SECRET)).toBeNull();
    await saveConnection(env.DB, SECRET, { refreshToken: "rt", account: "a@b.c" });
    expect(await loadConnection(env.DB, "rotated")).toBeNull();
  });

  it("round-trips state and sync, and clear removes everything", async () => {
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 5 });
    expect(await loadState(env.DB)).toEqual({ account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 5 });
    expect(await loadSync(env.DB)).toEqual({ at: null, error: null });
    await recordSync(env.DB, 100, null);
    expect(await loadSync(env.DB)).toEqual({ at: 100, error: null });
    await recordSync(env.DB, 200, "boom");
    expect(await loadSync(env.DB)).toEqual({ at: 200, error: "boom" });
    await clearConnection(env.DB);
    expect(await loadState(env.DB)).toBeNull();
    expect(await loadSync(env.DB)).toEqual({ at: null, error: null });
    expect(await loadConnection(env.DB, SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/store/google.test.ts`
Expected: FAIL (`encrypt` is not exported by the stub).

- [ ] **Step 3: Implement**

Replace `src/store/google.ts` with:

```ts
import type { Connection } from "../adapters/google";

export interface ConnectionSource { load(): Promise<Connection | null> }
export interface GoogleState { account: string; closedCalendarId: string; ordersCalendarId: string; connectedAt: number }

const KEY_TOKEN = "google.token";
const KEY_STATE = "google.state";
const KEY_SYNC = "google.sync";
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keyFor(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`google-token:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-GCM; output is base64(iv) + "." + base64(ciphertext). */
export async function encrypt(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), enc.encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decrypt(secret: string, packed: string): Promise<string> {
  const i = packed.indexOf(".");
  if (i < 0) throw new Error("google token: malformed");
  const iv = unb64(packed.slice(0, i)), ct = unb64(packed.slice(i + 1));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await keyFor(secret), ct);
  return dec.decode(pt);
}

async function getJson<T>(db: D1Database, key: string): Promise<T | null> {
  const r = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  return r ? (JSON.parse(r.value_json) as T) : null;
}
async function putJson(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(key, JSON.stringify(value)).run();
}

export async function saveConnection(db: D1Database, secret: string, conn: Connection): Promise<void> {
  await putJson(db, KEY_TOKEN, { account: conn.account, token: await encrypt(secret, conn.refreshToken) });
}

export async function loadConnection(db: D1Database, secret: string): Promise<Connection | null> {
  const row = await getJson<{ account: string; token: string }>(db, KEY_TOKEN);
  if (!row) return null;
  try {
    return { account: row.account, refreshToken: await decrypt(secret, row.token) };
  } catch (e) {
    console.error("google: stored token cannot be decrypted (ADMIN_SECRET rotated?); reconnect in admin", e);
    return null;
  }
}

export function connectionSource(db: D1Database, secret: string): ConnectionSource {
  return { load: () => loadConnection(db, secret) };
}

export async function saveState(db: D1Database, state: GoogleState): Promise<void> { await putJson(db, KEY_STATE, state); }
export async function loadState(db: D1Database): Promise<GoogleState | null> { return getJson<GoogleState>(db, KEY_STATE); }

export async function clearConnection(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key IN (?, ?, ?)").bind(KEY_TOKEN, KEY_STATE, KEY_SYNC).run();
}

export async function recordSync(db: D1Database, at: number, error: string | null): Promise<void> {
  await putJson(db, KEY_SYNC, { at, error });
}
export async function loadSync(db: D1Database): Promise<{ at: number | null; error: string | null }> {
  return (await getJson<{ at: number; error: string | null }>(db, KEY_SYNC)) ?? { at: null, error: null };
}
```

- [ ] **Step 4: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/store/google.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/google.ts tests/store/google.test.ts
git commit -m "feat(google): encrypted refresh-token store and connection state (D18)"
```

---

### Task 3: Real Google adapter over fetch (OAuth, Calendar v3, Gmail v1)

**Files:**
- Replace: `src/adapters/google-api.ts` (the Task 1 stub)
- Test: `tests/adapters/google-api.test.ts`

**Interfaces:**
- Consumes: `Google`, `Connection`, `CalendarEvent`, `NewAllDayEvent`, `Mail`, `GoogleNotConnected` (Task 1); `ConnectionSource` (Task 2).
- Produces: `class GoogleApi implements Google` with constructor `(clientId: string | undefined, clientSecret: string | undefined, source: ConnectionSource, fetchFn: typeof fetch = globalThis.fetch.bind(globalThis))`; exported pure helpers `buildRawMessage(fromName, fromAddress, mail): string` (base64url RFC 2822), `decodeIdTokenEmail(idToken): string`, `SCOPES: string[]`.
- `sendMail` sets `From: "The Bull and Bloom" <connected account>`; Gmail keeps a display name when the address is the account's own.

- [ ] **Step 1: Write the failing tests**

`tests/adapters/google-api.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GoogleApi, buildRawMessage, decodeIdTokenEmail } from "../../src/adapters/google-api";
import { GoogleNotConnected } from "../../src/adapters/google";

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
const source = (conn: { refreshToken: string; account: string } | null) => ({ load: async () => conn });
const CONN = { refreshToken: "rt_1", account: "thebullandbloom@gmail.com" };
const TOKEN = { status: 200, body: { access_token: "at_1", expires_in: 3600 } };

function b64url(s: string) { return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

describe("GoogleApi", () => {
  it("reports configured only with both client values", () => {
    expect(new GoogleApi("id", "secret", source(null)).configured()).toBe(true);
    expect(new GoogleApi(undefined, "secret", source(null)).configured()).toBe(false);
    expect(new GoogleApi("id", "", source(null)).configured()).toBe(false);
  });

  it("builds the consent url with offline access and forced consent", () => {
    const u = new URL(new GoogleApi("id-1", "s", source(null)).authUrl("st", "https://x.test/cb"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("id-1");
    expect(u.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/gmail.send", "openid", "email",
    ]));
  });

  it("exchanges a code for a refresh token and reads the account from the id token", async () => {
    const idToken = `h.${b64url(JSON.stringify({ email: "thebullandbloom@gmail.com" }))}.s`;
    const { fn, calls } = fakeFetch([{ status: 200, body: { access_token: "at", refresh_token: "rt_new", expires_in: 3600, id_token: idToken } }]);
    const g = new GoogleApi("id-1", "sec-1", source(null), fn);
    expect(await g.exchangeCode("the-code", "https://x.test/cb")).toEqual({ refreshToken: "rt_new", account: "thebullandbloom@gmail.com" });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(calls[0].body!);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("client_id")).toBe("id-1");
    expect(form.get("client_secret")).toBe("sec-1");
    expect(form.get("redirect_uri")).toBe("https://x.test/cb");
  });

  it("refuses an exchange that returns no refresh token", async () => {
    const { fn } = fakeFetch([{ status: 200, body: { access_token: "at", expires_in: 3600, id_token: "a.b.c" } }]);
    await expect(new GoogleApi("i", "s", source(null), fn).exchangeCode("c", "r")).rejects.toThrow(/refresh_token/);
  });

  it("throws GoogleNotConnected before any network call when there is no connection", async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(new GoogleApi("i", "s", source(null), fn).sendMail({ to: "a@b.c", subject: "s", text: "t" })).rejects.toBeInstanceOf(GoogleNotConnected);
    expect(calls).toHaveLength(0);
  });

  it("refreshes once, reuses the access token, and re-refreshes after a 401", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [], nextPageToken: undefined } },
      { status: 200, body: { items: [] } },
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { access_token: "at_2", expires_in: 3600 } },
      { status: 200, body: { items: [] } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    await g.listEvents("cal", new Date(0), new Date(1000));
    await g.listEvents("cal", new Date(0), new Date(1000));
    await g.listEvents("cal", new Date(0), new Date(1000));
    const tokenCalls = calls.filter((c) => c.url === "https://oauth2.googleapis.com/token");
    expect(tokenCalls).toHaveLength(2);
    expect(new URLSearchParams(tokenCalls[0].body!).get("grant_type")).toBe("refresh_token");
    expect(calls[1].headers.authorization).toBe("Bearer at_1");
    expect(calls[5].headers.authorization).toBe("Bearer at_2");
  });

  it("lists events across pages with singleEvents and the time window", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [{ id: "e1", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }], nextPageToken: "p2" } },
      { status: 200, body: { items: [{ id: "e2", start: { date: "2026-09-12" }, end: { date: "2026-09-13" } }] } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    const evs = await g.listEvents("my cal@group", new Date("2026-09-08T00:00:00Z"), new Date("2026-12-07T00:00:00Z"));
    expect(evs.map((e) => e.id)).toEqual(["e1", "e2"]);
    const u1 = new URL(calls[1].url), u2 = new URL(calls[2].url);
    expect(u1.pathname).toBe("/calendar/v3/calendars/my%20cal%40group/events");
    expect(u1.searchParams.get("singleEvents")).toBe("true");
    expect(u1.searchParams.get("timeMin")).toBe("2026-09-08T00:00:00.000Z");
    expect(u1.searchParams.get("timeMax")).toBe("2026-12-07T00:00:00.000Z");
    expect(u2.searchParams.get("pageToken")).toBe("p2");
  });

  it("finds an existing calendar by name, else creates one", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [{ id: "c-closed", summary: "Bull and Bloom: Closed" }] } },
      { status: 200, body: { items: [{ id: "c-closed", summary: "Bull and Bloom: Closed" }] } },
      { status: 200, body: { id: "c-orders", summary: "Bull and Bloom: Orders" } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    expect(await g.ensureCalendar("Bull and Bloom: Closed", "America/New_York")).toBe("c-closed");
    expect(await g.ensureCalendar("Bull and Bloom: Orders", "America/New_York")).toBe("c-orders");
    expect(calls[3].method).toBe("POST");
    expect(calls[3].url).toBe("https://www.googleapis.com/calendar/v3/calendars");
    expect(JSON.parse(calls[3].body!)).toEqual({ summary: "Bull and Bloom: Orders", timeZone: "America/New_York" });
  });

  it("inserts an all-day event with our id and treats 409 as success (D21)", async () => {
    const { fn, calls } = fakeFetch([
      TOKEN,
      { status: 200, body: { id: "bbabc" } },
      { status: 409, body: { error: { message: "The requested identifier already exists." } } },
    ]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    const ev = { id: "bbabc", date: "2026-09-10", summary: "Bouquet · Pat · pickup", description: "d" };
    expect(await g.insertAllDayEvent("cal", ev)).toBe("bbabc");
    expect(await g.insertAllDayEvent("cal", ev)).toBe("bbabc");
    expect(JSON.parse(calls[1].body!)).toEqual({
      id: "bbabc", summary: "Bouquet · Pat · pickup", description: "d",
      start: { date: "2026-09-10" }, end: { date: "2026-09-11" },
    });
  });

  it("sends mail as a base64url raw message from the connected account", async () => {
    const { fn, calls } = fakeFetch([TOKEN, { status: 200, body: { id: "m1" } }]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    await g.sendMail({ to: "pat@example.com", subject: "Hi", text: "Body" });
    expect(calls[1].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const raw = JSON.parse(calls[1].body!).raw as string;
    expect(raw).toBe(buildRawMessage("The Bull and Bloom", "thebullandbloom@gmail.com", { to: "pat@example.com", subject: "Hi", text: "Body" }));
  });

  it("surfaces non-2xx responses as errors with status and body", async () => {
    const { fn } = fakeFetch([TOKEN, { status: 403, body: { error: { message: "Insufficient Permission" } } }]);
    const g = new GoogleApi("i", "s", source(CONN), fn);
    await expect(g.sendMail({ to: "a@b.c", subject: "s", text: "t" })).rejects.toThrow(/403.*Insufficient Permission/);
  });
});

describe("buildRawMessage", () => {
  function decode(raw: string) {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    return decodeURIComponent(escape(atob(b64)));
  }
  it("emits the headers and a base64 utf-8 body", () => {
    const msg = decode(buildRawMessage("The Bull and Bloom", "shop@example.com", { to: "pat@example.com", subject: "Your bouquet", text: "Hi Pat,\n\nThanks." }));
    const [head, body] = msg.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "From: The Bull and Bloom <shop@example.com>",
      "To: pat@example.com",
      "Subject: Your bouquet",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(decodeURIComponent(escape(atob(body.replace(/\r\n/g, ""))))).toBe("Hi Pat,\n\nThanks.");
  });
  it("encodes a non-ascii subject per RFC 2047", () => {
    const msg = decode(buildRawMessage("N", "n@example.com", { to: "a@b.c", subject: "Bouquet · José", text: "x" }));
    const subject = msg.split("\r\n").find((l) => l.startsWith("Subject: "))!;
    expect(subject).toMatch(/^Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const inner = subject.slice("Subject: =?utf-8?B?".length, -2);
    expect(decodeURIComponent(escape(atob(inner)))).toBe("Bouquet · José");
  });
});

describe("decodeIdTokenEmail", () => {
  it("reads the email claim", () => {
    expect(decodeIdTokenEmail(`x.${b64url(JSON.stringify({ sub: "1", email: "a@b.c" }))}.y`)).toBe("a@b.c");
  });
  it("throws when the claim is missing", () => {
    expect(() => decodeIdTokenEmail(`x.${b64url("{}")}.y`)).toThrow(/email/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/adapters/google-api.test.ts`
Expected: FAIL (`buildRawMessage` not exported; stub methods throw).

- [ ] **Step 3: Implement**

Replace `src/adapters/google-api.ts` with:

```ts
import { GoogleNotConnected, type CalendarEvent, type Connection, type Google, type Mail, type NewAllDayEvent } from "./google";
import type { ConnectionSource } from "../store/google";
import { addDays } from "../core/time";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL = "https://www.googleapis.com/calendar/v3";
const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const FROM_NAME = "The Bull and Bloom";
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function wrap76(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?utf-8?B?${b64(enc.encode(s))}?=`;
}

/** RFC 2822 text/plain message, base64url-encoded as Gmail's `raw` field wants it. */
export function buildRawMessage(fromName: string, fromAddress: string, mail: Mail): string {
  const lines = [
    `From: ${encodeHeader(fromName)} <${fromAddress}>`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(enc.encode(mail.text))),
  ];
  return b64url(enc.encode(lines.join("\r\n")));
}

export function decodeIdTokenEmail(idToken: string): string {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("google: malformed id_token");
  const claims = JSON.parse(dec.decode(unb64url(parts[1])));
  if (typeof claims.email !== "string") throw new Error("google: id_token has no email claim");
  return claims.email;
}

interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string; id_token?: string }

export class GoogleApi implements Google {
  private access: { refreshToken: string; token: string; expiresAt: number } | null = null;

  constructor(
    private clientId: string | undefined,
    private clientSecret: string | undefined,
    private source: ConnectionSource,
    private fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  configured(): boolean { return Boolean(this.clientId && this.clientSecret); }

  authUrl(state: string, redirectUri: string): string {
    const u = new URL(AUTH_URL);
    u.searchParams.set("client_id", this.clientId ?? "");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<Connection> {
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (!t.refresh_token) throw new Error("google: token response has no refresh_token (was consent granted with access_type=offline?)");
    const account = decodeIdTokenEmail(t.id_token ?? "");
    this.access = { refreshToken: t.refresh_token, token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
    return { refreshToken: t.refresh_token, account };
  }

  async listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const u = new URL(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events`);
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("orderBy", "startTime");
      u.searchParams.set("maxResults", "250");
      u.searchParams.set("timeMin", timeMin.toISOString());
      u.searchParams.set("timeMax", timeMax.toISOString());
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const page = await this.api<{ items?: CalendarEvent[]; nextPageToken?: string }>("GET", u.toString());
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async ensureCalendar(summary: string, timeZone: string): Promise<string> {
    let pageToken: string | undefined;
    do {
      const u = new URL(`${CAL}/users/me/calendarList`);
      u.searchParams.set("minAccessRole", "owner");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const page = await this.api<{ items?: Array<{ id: string; summary: string }>; nextPageToken?: string }>("GET", u.toString());
      const hit = (page.items ?? []).find((c) => c.summary === summary);
      if (hit) return hit.id;
      pageToken = page.nextPageToken;
    } while (pageToken);
    const created = await this.api<{ id: string }>("POST", `${CAL}/calendars`, { summary, timeZone });
    return created.id;
  }

  async insertAllDayEvent(calendarId: string, event: NewAllDayEvent): Promise<string> {
    const body = {
      id: event.id, summary: event.summary, description: event.description,
      start: { date: event.date }, end: { date: addDays(event.date, 1) },
    };
    await this.api("POST", `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, body, [409]);
    return event.id;
  }

  async sendMail(mail: Mail): Promise<void> {
    const { account } = await this.accessToken();
    await this.api("POST", GMAIL_SEND, { raw: buildRawMessage(FROM_NAME, account, mail) });
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const form = new URLSearchParams({ ...params, client_id: this.clientId ?? "", client_secret: this.clientSecret ?? "" });
    const r = await this.fetchFn(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const text = await r.text();
    if (!r.ok) throw new Error(`google token ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as TokenResponse;
  }

  private async accessToken(): Promise<{ token: string; account: string }> {
    const conn = await this.source.load();
    if (!conn) throw new GoogleNotConnected();
    if (!this.access || this.access.refreshToken !== conn.refreshToken || this.access.expiresAt <= Date.now()) {
      const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: conn.refreshToken });
      this.access = { refreshToken: conn.refreshToken, token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
    }
    return { token: this.access.token, account: conn.account };
  }

  /** Authenticated JSON call. Retries once after a 401 with a fresh access token. `okAlso` statuses are accepted as success. */
  private async api<T = unknown>(method: string, url: string, body?: unknown, okAlso: number[] = []): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const { token } = await this.accessToken();
      const r = await this.fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401 && attempt === 0) { this.access = null; continue; }
      const text = await r.text();
      if (r.ok || okAlso.includes(r.status)) return (text ? JSON.parse(text) : {}) as T;
      throw new Error(`google ${method} ${new URL(url).pathname} ${r.status}: ${text.slice(0, 300)}`);
    }
  }
}
```

- [ ] **Step 4: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/adapters/google-api.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/google-api.ts tests/adapters/google-api.test.ts
git commit -m "feat(google): fetch-based adapter for OAuth, Calendar v3, and Gmail send"
```

---

### Task 4: Blackout core (events → closed dates)

**Files:**
- Create: `src/core/blackouts.ts`
- Test: `tests/core/blackouts.test.ts`

**Interfaces:**
- Consumes: `CalendarEvent` (type only, Task 1); `ymdIn`, `addDays` from `src/core/time.ts`.
- Produces: `closedDatesFromEvents(events: CalendarEvent[], tz: string, from: string, to: string): Map<string, string>` mapping each closed `YYYY-MM-DD` within `[from, to]` to the id of the first event covering it.

Rules: cancelled events are ignored. All-day events cover `start.date` through the day before `end.date` (Google's all-day `end.date` is exclusive); if `end.date` is missing or not after `start.date`, they cover `start.date` only. Timed events cover every studio-local date from `ymdIn(tz, start)` to `ymdIn(tz, end − 1 ms)`; an event ending exactly at local midnight therefore does not close the next day. Events with neither `start.date` nor `start.dateTime` are ignored.

- [ ] **Step 1: Write the failing tests**

`tests/core/blackouts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { closedDatesFromEvents } from "../../src/core/blackouts";

const TZ = "America/New_York";
const FROM = "2026-09-08", TO = "2026-12-07";
const keys = (m: Map<string, string>) => [...m.keys()].sort();

describe("closedDatesFromEvents", () => {
  it("covers a single all-day event", () => {
    const m = closedDatesFromEvents([{ id: "e1", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }], TZ, FROM, TO);
    expect([...m]).toEqual([["2026-09-10", "e1"]]);
  });
  it("treats the all-day end date as exclusive", () => {
    const m = closedDatesFromEvents([{ id: "e1", start: { date: "2026-09-10" }, end: { date: "2026-09-13" } }], TZ, FROM, TO);
    expect(keys(m)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
  });
  it("covers start.date only when end is missing or not after start", () => {
    expect(keys(closedDatesFromEvents([{ id: "e", start: { date: "2026-09-10" }, end: {} }], TZ, FROM, TO))).toEqual(["2026-09-10"]);
    expect(keys(closedDatesFromEvents([{ id: "e", start: { date: "2026-09-10" }, end: { date: "2026-09-10" } }], TZ, FROM, TO))).toEqual(["2026-09-10"]);
  });
  it("maps a timed event to its studio-local dates, crossing midnight in New York", () => {
    // 2026-09-10 23:00 EDT (03:00Z on the 11th) to 2026-09-11 01:00 EDT (05:00Z)
    const m = closedDatesFromEvents([{ id: "t", start: { dateTime: "2026-09-11T03:00:00Z" }, end: { dateTime: "2026-09-11T05:00:00Z" } }], TZ, FROM, TO);
    expect(keys(m)).toEqual(["2026-09-10", "2026-09-11"]);
  });
  it("does not close the next day when a timed event ends exactly at local midnight", () => {
    // 2026-09-10 20:00 EDT to 2026-09-11 00:00 EDT (04:00Z)
    const m = closedDatesFromEvents([{ id: "t", start: { dateTime: "2026-09-11T00:00:00Z" }, end: { dateTime: "2026-09-11T04:00:00Z" } }], TZ, FROM, TO);
    expect(keys(m)).toEqual(["2026-09-10"]);
  });
  it("ignores cancelled and malformed events", () => {
    const m = closedDatesFromEvents([
      { id: "c", status: "cancelled", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } },
      { id: "x", start: {}, end: {} },
    ], TZ, FROM, TO);
    expect(m.size).toBe(0);
  });
  it("clips to the window and keeps the first event for a day", () => {
    const m = closedDatesFromEvents([
      { id: "a", start: { date: "2026-09-06" }, end: { date: "2026-09-10" } },
      { id: "b", start: { date: "2026-09-09" }, end: { date: "2026-09-12" } },
      { id: "z", start: { date: "2026-12-06" }, end: { date: "2026-12-10" } },
    ], TZ, FROM, TO);
    expect([...m]).toEqual([
      ["2026-09-08", "a"], ["2026-09-09", "a"], ["2026-09-10", "b"], ["2026-09-11", "b"],
      ["2026-12-06", "z"], ["2026-12-07", "z"],
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/core/blackouts.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/core/blackouts.ts`:

```ts
import type { CalendarEvent } from "../adapters/google";
import { addDays, ymdIn } from "./time";

/** Studio-local dates within [from, to] covered by any non-cancelled event, mapped to the first covering event's id. */
export function closedDatesFromEvents(events: CalendarEvent[], tz: string, from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    const span = spanOf(ev, tz);
    if (!span) continue;
    for (let d = span.first < from ? from : span.first; d <= span.last && d <= to; d = addDays(d, 1)) {
      if (!out.has(d)) out.set(d, ev.id);
    }
  }
  return out;
}

function spanOf(ev: CalendarEvent, tz: string): { first: string; last: string } | null {
  if (ev.start.date) {
    const first = ev.start.date;
    const last = ev.end.date && ev.end.date > first ? addDays(ev.end.date, -1) : first;
    return { first, last };
  }
  if (ev.start.dateTime) {
    const first = ymdIn(tz, new Date(ev.start.dateTime));
    const last = ev.end.dateTime ? ymdIn(tz, new Date(new Date(ev.end.dateTime).getTime() - 1)) : first;
    return { first, last: last < first ? first : last };
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/core/blackouts.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/blackouts.ts tests/core/blackouts.test.ts
git commit -m "feat(blackouts): pure mapping from calendar events to closed studio dates"
```

---

### Task 5: Calendar-sourced overrides and the blackout sync job

**Files:**
- Modify: `src/store/overrides.ts`, `store.config.json`, `src/config.ts`
- Create: `src/jobs/blackouts.ts`
- Test: `tests/store/overrides.test.ts` (append), `tests/jobs/blackouts.test.ts`, `tests/config.test.ts` (append)

**Interfaces:**
- Consumes: `closedDatesFromEvents` (Task 4); `Google` (Task 1); `loadState`, `recordSync` (Task 2); `ymdIn`, `addDays`.
- Produces:
  - `syncCalendarOverrides(db, from, to, closed: Map<string, string>): Promise<{ added: number; removed: number }>` in `src/store/overrides.ts`.
  - `syncBlackouts(db, google, tz, now): Promise<BlackoutSyncResult>` in `src/jobs/blackouts.ts`, where `type BlackoutSyncResult = { status: "skipped" } | { status: "ok"; added: number; removed: number; closed: number } | { status: "error"; error: string }`.
  - `StoreConfig.studio.ownerEmail: string` and `StoreConfig.calendars: { closed: string; orders: string }`.
  - Constant `SYNC_DAYS = 90` (spec §4.4) exported from `src/jobs/blackouts.ts`.

- [ ] **Step 1: Extend the repo config**

`store.config.json` — add `ownerEmail` inside `studio` and a top-level `calendars` block:

```json
  "studio": {
    "pickupAddress": "SAMPLE — studio address, Upstate NY",
    "pickupInstructions": "SAMPLE — text Anthony at (518) 334-0517 when you arrive.",
    "ownerEmail": "thebullandbloom@gmail.com"
  },
  "calendars": { "closed": "Bull and Bloom: Closed", "orders": "Bull and Bloom: Orders" },
```

`src/config.ts` — extend the interface and validation:

```ts
export interface StoreConfig {
  timezone: string;
  studio: { pickupAddress: string; pickupInstructions: string; ownerEmail: string };
  calendars: { closed: string; orders: string };
  sizes: Size[];
  defaults: { cap: number; cutoff: string; openWeekdays: number[] };
  holdMinutes: number;
}
```

and in `validateConfig`, after the `holdMinutes` check:

```ts
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.studio?.ownerEmail ?? "")) throw new Error("config: studio.ownerEmail must be an email address");
  if (!cfg.calendars?.closed || !cfg.calendars?.orders || cfg.calendars.closed === cfg.calendars.orders)
    throw new Error("config: calendars.closed and calendars.orders must be two distinct names");
```

Append to `tests/config.test.ts` inside the describe:

```ts
  it("rejects a bad owner email and identical calendar names", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, ownerEmail: "nope" } })).toThrow(/ownerEmail/);
    expect(() => validateConfig({ ...base, calendars: { closed: "Same", orders: "Same" } })).toThrow(/calendars/);
  });
```

- [ ] **Step 2: Write the failing store test**

Append to `tests/store/overrides.test.ts` (add `syncCalendarOverrides` to the existing import from `../../src/store/overrides`):

```ts
describe("syncCalendarOverrides", () => {
  it("adds and removes calendar rows without touching admin rows", async () => {
    await env.DB.prepare("DELETE FROM day_overrides WHERE date BETWEEN '2026-10-01' AND '2026-10-31'").run();
    await env.DB.prepare("INSERT INTO day_overrides (date, source, cap, closed) VALUES ('2026-10-02', 'admin', 2, 0)").run();
    await env.DB.prepare("INSERT INTO day_overrides (date, source, cap, closed, calendar_event_id) VALUES ('2026-10-03', 'calendar', NULL, 1, 'old')").run();

    const r1 = await syncCalendarOverrides(env.DB, "2026-10-01", "2026-10-31", new Map([["2026-10-02", "e2"], ["2026-10-05", "e5"]]));
    expect(r1).toEqual({ added: 2, removed: 1 });
    const rows = await env.DB.prepare("SELECT date, source, cap, closed, calendar_event_id FROM day_overrides WHERE date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY date, source").all<any>();
    expect(rows.results).toEqual([
      { date: "2026-10-02", source: "admin", cap: 2, closed: 0, calendar_event_id: null },
      { date: "2026-10-02", source: "calendar", cap: null, closed: 1, calendar_event_id: "e2" },
      { date: "2026-10-05", source: "calendar", cap: null, closed: 1, calendar_event_id: "e5" },
    ]);
    // the merged view: 10-02 is closed (calendar wins on closed) with the admin cap still recorded
    const merged = await getOverrides(env.DB, "2026-10-01", "2026-10-31");
    expect(merged.get("2026-10-02")).toEqual({ cap: 2, closed: true });
    expect(merged.get("2026-10-05")).toEqual({ cap: null, closed: true });

    const r2 = await syncCalendarOverrides(env.DB, "2026-10-01", "2026-10-31", new Map([["2026-10-05", "e5b"]]));
    expect(r2).toEqual({ added: 0, removed: 1 });
    const after = await env.DB.prepare("SELECT date, source, calendar_event_id FROM day_overrides WHERE date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY date, source").all<any>();
    expect(after.results).toEqual([
      { date: "2026-10-02", source: "admin", calendar_event_id: null },
      { date: "2026-10-05", source: "calendar", calendar_event_id: "e5b" },
    ]);
  });
  it("leaves calendar rows outside the window alone", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO day_overrides (date, source, cap, closed, calendar_event_id) VALUES ('2027-01-05', 'calendar', NULL, 1, 'far')").run();
    await syncCalendarOverrides(env.DB, "2026-10-01", "2026-10-31", new Map());
    const far = await env.DB.prepare("SELECT calendar_event_id FROM day_overrides WHERE date = '2027-01-05'").first<any>();
    expect(far).toEqual({ calendar_event_id: "far" });
  });
});
```

Run: `npx vitest run tests/store/overrides.test.ts` — expected FAIL (not exported).

- [ ] **Step 3: Implement the store function**

Append to `src/store/overrides.ts`:

```ts
/** Make the calendar-sourced rows in [from, to] equal `closed` (date -> event id). Admin rows are never touched. */
export async function syncCalendarOverrides(
  db: D1Database, from: string, to: string, closed: Map<string, string>,
): Promise<{ added: number; removed: number }> {
  const existing = await db.prepare("SELECT date FROM day_overrides WHERE source = 'calendar' AND date BETWEEN ? AND ?")
    .bind(from, to).all<{ date: string }>();
  const have = new Set(existing.results.map((r) => r.date));
  const stmts: D1PreparedStatement[] = [];
  let added = 0, removed = 0;
  for (const [date, eventId] of closed) {
    if (!have.has(date)) added++;
    stmts.push(db.prepare(
      `INSERT INTO day_overrides (date, source, cap, closed, calendar_event_id) VALUES (?, 'calendar', NULL, 1, ?)
       ON CONFLICT(date, source) DO UPDATE SET closed = 1, calendar_event_id = excluded.calendar_event_id`,
    ).bind(date, eventId));
  }
  for (const date of have) {
    if (closed.has(date)) continue;
    removed++;
    stmts.push(db.prepare("DELETE FROM day_overrides WHERE date = ? AND source = 'calendar'").bind(date));
  }
  if (stmts.length) await db.batch(stmts);
  return { added, removed };
}
```

Run: `npx vitest run tests/store/overrides.test.ts tests/config.test.ts` — expected PASS.

- [ ] **Step 4: Write the failing job test**

`tests/jobs/blackouts.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { syncBlackouts, SYNC_DAYS } from "../../src/jobs/blackouts";
import { clearConnection, saveState, loadSync } from "../../src/store/google";
import { FakeGoogle } from "../fakes/google";

const TZ = "America/New_York";
const NOW = new Date("2026-09-08T14:00:00Z"); // Tue Sep 8, 10:00 EDT
const STATE = { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 };

describe("syncBlackouts", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
  });

  it("skips when Google is not connected", async () => {
    const g = new FakeGoogle();
    expect(await syncBlackouts(env.DB, g, TZ, NOW)).toEqual({ status: "skipped" });
    expect(await loadSync(env.DB)).toEqual({ at: null, error: null });
  });

  it("writes closed days from the Closed calendar over a 90-day window and records the sync", async () => {
    await saveState(env.DB, STATE);
    const g = new FakeGoogle();
    g.events["cal_closed"] = [
      { id: "vac", start: { date: "2026-09-14" }, end: { date: "2026-09-17" } },
      { id: "past", start: { date: "2026-09-01" }, end: { date: "2026-09-02" } },
      { id: "far", start: { date: "2027-01-10" }, end: { date: "2027-01-11" } },
    ];
    const r = await syncBlackouts(env.DB, g, TZ, NOW);
    expect(r).toEqual({ status: "ok", added: 3, removed: 0, closed: 3 });
    const rows = await env.DB.prepare("SELECT date, calendar_event_id FROM day_overrides WHERE source = 'calendar' ORDER BY date").all<any>();
    expect(rows.results).toEqual([
      { date: "2026-09-14", calendar_event_id: "vac" },
      { date: "2026-09-15", calendar_event_id: "vac" },
      { date: "2026-09-16", calendar_event_id: "vac" },
    ]);
    expect(await loadSync(env.DB)).toEqual({ at: Math.floor(NOW.getTime() / 1000), error: null });
    expect(SYNC_DAYS).toBe(90);
  });

  it("removes days whose event disappeared", async () => {
    await saveState(env.DB, STATE);
    const g = new FakeGoogle();
    g.events["cal_closed"] = [{ id: "a", start: { date: "2026-09-20" }, end: { date: "2026-09-21" } }];
    await syncBlackouts(env.DB, g, TZ, NOW);
    g.events["cal_closed"] = [];
    expect(await syncBlackouts(env.DB, g, TZ, NOW)).toEqual({ status: "ok", added: 0, removed: 1, closed: 0 });
  });

  it("keeps the last state and records the error when Google fails", async () => {
    await saveState(env.DB, STATE);
    const g = new FakeGoogle();
    g.events["cal_closed"] = [{ id: "a", start: { date: "2026-09-20" }, end: { date: "2026-09-21" } }];
    await syncBlackouts(env.DB, g, TZ, NOW);
    g.failNext = "google down";
    const later = new Date(NOW.getTime() + 900_000);
    expect(await syncBlackouts(env.DB, g, TZ, later)).toEqual({ status: "error", error: "google down" });
    const rows = await env.DB.prepare("SELECT date FROM day_overrides WHERE source = 'calendar'").all<any>();
    expect(rows.results).toEqual([{ date: "2026-09-20" }]);
    expect(await loadSync(env.DB)).toEqual({ at: Math.floor(later.getTime() / 1000), error: "google down" });
  });
});
```

Run: `npx vitest run tests/jobs/blackouts.test.ts` — expected FAIL (module not found).

- [ ] **Step 5: Implement the job**

`src/jobs/blackouts.ts`:

```ts
import type { Google } from "../adapters/google";
import { closedDatesFromEvents } from "../core/blackouts";
import { addDays, ymdIn } from "../core/time";
import { loadState, recordSync } from "../store/google";
import { syncCalendarOverrides } from "../store/overrides";

export const SYNC_DAYS = 90; // spec §4.4

export type BlackoutSyncResult =
  | { status: "skipped" }
  | { status: "ok"; added: number; removed: number; closed: number }
  | { status: "error"; error: string };

/** Read the Closed calendar for the next SYNC_DAYS days and mirror it into calendar-sourced overrides. */
export async function syncBlackouts(db: D1Database, google: Google, tz: string, now: Date): Promise<BlackoutSyncResult> {
  const state = await loadState(db);
  if (!state) return { status: "skipped" };
  const from = ymdIn(tz, now);
  const to = addDays(from, SYNC_DAYS);
  const nowSec = Math.floor(now.getTime() / 1000);
  try {
    // Pad the query window by a day each side: an event that began yesterday may still cover today,
    // and the exclusive all-day end can sit on the day after `to`.
    const timeMin = new Date(`${addDays(from, -1)}T00:00:00Z`);
    const timeMax = new Date(`${addDays(to, 2)}T00:00:00Z`);
    const events = await google.listEvents(state.closedCalendarId, timeMin, timeMax);
    const closed = closedDatesFromEvents(events, tz, from, to);
    const { added, removed } = await syncCalendarOverrides(db, from, to, closed);
    await recordSync(db, nowSec, null);
    return { status: "ok", added, removed, closed: closed.size };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("blackouts: sync failed, keeping last state", error);
    await recordSync(db, nowSec, error);
    return { status: "error", error };
  }
}
```

- [ ] **Step 6: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/jobs/blackouts.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add store.config.json src/config.ts src/store/overrides.ts src/jobs/blackouts.ts tests/config.test.ts tests/store/overrides.test.ts tests/jobs/blackouts.test.ts
git commit -m "feat(blackouts): mirror the Closed calendar into calendar-sourced overrides"
```

---

### Task 6: Outbox table and store

**Files:**
- Create: `migrations/0002_outbox.sql`, `src/store/outbox.ts`
- Test: `tests/store/outbox.test.ts`

**Interfaces:**
- Produces (all in `src/store/outbox.ts`):
  - `type OutboxKind = "calendar_event" | "email_customer" | "email_owner"`
  - `const ORDER_PAID_KINDS: readonly OutboxKind[]` (all three)
  - `interface OutboxItem { id: string; kind: OutboxKind; orderId: string; createdAt: number; attempts: number; nextAttemptAt: number | null; lastError: string | null; doneAt: number | null }`
  - `enqueueForSessionStatements(db, sessionId, kinds, now): D1PreparedStatement[]` — `INSERT OR IGNORE … SELECT … FROM orders WHERE stripe_session_id = ? AND status = 'paid'`, so it is a no-op unless the order is paid, and idempotent on `(order_id, kind)`.
  - `dueItems(db, now, limit = 20): Promise<OutboxItem[]>` — not done, `next_attempt_at <= now`, oldest first.
  - `markDone(db, id, now)`, `markFailed(db, id, attempts, nextAttemptAt, error)`.
  - `counts(db): Promise<{ pending: number; failed: number }>` — pending = not done with a scheduled attempt; failed = not done and given up (`next_attempt_at IS NULL`).
  - `retryFailed(db, now): Promise<number>` — reschedules every failed row for `now` with `attempts = 0`.
  - `backoff(attempts, now): number | null` — `attempts` is the count AFTER the failed try; returns `now + 60 · 2^min(attempts, 6)` seconds, or `null` once `attempts >= MAX_ATTEMPTS` (24).
- The migration is picked up automatically by `tests/setup.ts` (it applies every file in `migrations/`).

- [ ] **Step 1: Write the migration**

`migrations/0002_outbox.sql`:

```sql
-- D20: queued side effects of a paid order. One row per (order, kind); the Stripe webhook
-- inserts them in the same batch as the status flip, the drain job delivers and retries.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_event','email_customer','email_owner')),
  order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,          -- NULL = given up; admin "retry" resets it
  last_error TEXT,
  done_at INTEGER,
  UNIQUE (order_id, kind)
);
CREATE INDEX outbox_due ON outbox (done_at, next_attempt_at);
```

- [ ] **Step 2: Write the failing tests**

`tests/store/outbox.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  ORDER_PAID_KINDS, backoff, counts, dueItems, enqueueForSessionStatements, markDone, markFailed, retryFailed,
} from "../../src/store/outbox";

async function order(id: string, session: string, status: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id)
     VALUES (?, 1, ?, '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, ?)`,
  ).bind(id, status, session).run();
}

describe("store/outbox", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM outbox").run(); });

  it("enqueues three rows for a paid session, idempotently, and nothing for an unpaid one", async () => {
    await order("o1", "cs_o1", "paid");
    await order("o2", "cs_o2", "held");
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 1000));
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 2000));
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o2", ORDER_PAID_KINDS, 1000));
    const rows = await env.DB.prepare("SELECT order_id, kind, created_at, attempts, next_attempt_at FROM outbox ORDER BY kind").all<any>();
    expect(rows.results).toEqual([
      { order_id: "o1", kind: "calendar_event", created_at: 1000, attempts: 0, next_attempt_at: 1000 },
      { order_id: "o1", kind: "email_customer", created_at: 1000, attempts: 0, next_attempt_at: 1000 },
      { order_id: "o1", kind: "email_owner", created_at: 1000, attempts: 0, next_attempt_at: 1000 },
    ]);
  });

  it("lists due items oldest first and respects the limit", async () => {
    await order("o1", "cs_o1", "paid");
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 1000));
    expect((await dueItems(env.DB, 999)).length).toBe(0);
    const due = await dueItems(env.DB, 1000);
    expect(due.map((i) => i.kind)).toEqual(["calendar_event", "email_customer", "email_owner"]);
    expect(due[0]).toMatchObject({ orderId: "o1", attempts: 0, nextAttemptAt: 1000, lastError: null, doneAt: null });
    expect((await dueItems(env.DB, 1000, 2)).length).toBe(2);
  });

  it("marks done and failed, counts, and retries", async () => {
    await order("o1", "cs_o1", "paid");
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 1000));
    const [a, b, c] = await dueItems(env.DB, 1000);
    await markDone(env.DB, a.id, 1001);
    await markFailed(env.DB, b.id, 1, 1120, "boom");
    await markFailed(env.DB, c.id, 24, null, "gave up");
    expect(await counts(env.DB)).toEqual({ pending: 1, failed: 1 });
    expect((await dueItems(env.DB, 1119)).length).toBe(0);
    expect((await dueItems(env.DB, 1120)).map((i) => i.id)).toEqual([b.id]);
    const failedRow = await env.DB.prepare("SELECT attempts, next_attempt_at, last_error, done_at FROM outbox WHERE id = ?").bind(c.id).first<any>();
    expect(failedRow).toEqual({ attempts: 24, next_attempt_at: null, last_error: "gave up", done_at: null });
    expect(await retryFailed(env.DB, 5000)).toBe(1);
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    expect((await dueItems(env.DB, 5000)).map((i) => i.id).sort()).toEqual([b.id, c.id].sort());
    const reset = await env.DB.prepare("SELECT attempts, next_attempt_at FROM outbox WHERE id = ?").bind(c.id).first<any>();
    expect(reset).toEqual({ attempts: 0, next_attempt_at: 5000 });
  });

  it("backs off exponentially, caps the delay, and gives up after 24 attempts", () => {
    expect(backoff(1, 0)).toBe(120);
    expect(backoff(2, 0)).toBe(240);
    expect(backoff(6, 0)).toBe(3840);
    expect(backoff(7, 0)).toBe(3840);
    expect(backoff(23, 1000)).toBe(4840);
    expect(backoff(24, 0)).toBeNull();
  });
});
```

Run: `npx vitest run tests/store/outbox.test.ts` — expected FAIL (module not found).

- [ ] **Step 3: Implement**

`src/store/outbox.ts`:

```ts
export type OutboxKind = "calendar_event" | "email_customer" | "email_owner";
export const ORDER_PAID_KINDS: readonly OutboxKind[] = ["calendar_event", "email_customer", "email_owner"];
export const MAX_ATTEMPTS = 24;

export interface OutboxItem {
  id: string; kind: OutboxKind; orderId: string; createdAt: number; attempts: number;
  nextAttemptAt: number | null; lastError: string | null; doneAt: number | null;
}
interface Row {
  id: string; kind: OutboxKind; order_id: string; created_at: number; attempts: number;
  next_attempt_at: number | null; last_error: string | null; done_at: number | null;
}
const COLS = "id, kind, order_id, created_at, attempts, next_attempt_at, last_error, done_at";
function fromRow(r: Row): OutboxItem {
  return { id: r.id, kind: r.kind, orderId: r.order_id, createdAt: r.created_at, attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at, lastError: r.last_error, doneAt: r.done_at };
}

/**
 * One INSERT per kind, each guarded by "the order for this session is paid", so the statements
 * can ride in the same batch as the paid UPDATE and are no-ops on a duplicate webhook.
 */
export function enqueueForSessionStatements(
  db: D1Database, sessionId: string, kinds: readonly OutboxKind[], now: number,
): D1PreparedStatement[] {
  return kinds.map((kind) => db.prepare(
    `INSERT OR IGNORE INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at)
     SELECT ?1, ?2, id, ?3, 0, ?3 FROM orders WHERE stripe_session_id = ?4 AND status = 'paid'`,
  ).bind(crypto.randomUUID(), kind, now, sessionId));
}

export async function dueItems(db: D1Database, now: number, limit = 20): Promise<OutboxItem[]> {
  const rows = await db.prepare(
    `SELECT ${COLS} FROM outbox WHERE done_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
     ORDER BY created_at, kind LIMIT ?`,
  ).bind(now, limit).all<Row>();
  return rows.results.map(fromRow);
}

export async function markDone(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE outbox SET done_at = ?, last_error = NULL WHERE id = ?").bind(now, id).run();
}

export async function markFailed(db: D1Database, id: string, attempts: number, nextAttemptAt: number | null, error: string): Promise<void> {
  await db.prepare("UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
    .bind(attempts, nextAttemptAt, error.slice(0, 500), id).run();
}

export async function counts(db: D1Database): Promise<{ pending: number; failed: number }> {
  const r = await db.prepare(
    `SELECT SUM(CASE WHEN next_attempt_at IS NOT NULL THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN next_attempt_at IS NULL THEN 1 ELSE 0 END) AS failed
     FROM outbox WHERE done_at IS NULL`,
  ).first<{ pending: number | null; failed: number | null }>();
  return { pending: r?.pending ?? 0, failed: r?.failed ?? 0 };
}

export async function retryFailed(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare("UPDATE outbox SET attempts = 0, next_attempt_at = ? WHERE done_at IS NULL AND next_attempt_at IS NULL").bind(now).run();
  return r.meta.changes;
}

/** Next attempt time after `attempts` failures (2, 4, 8 … 64 minutes, capped), or null once we give up. */
export function backoff(attempts: number, now: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return now + 60 * 2 ** Math.min(attempts, 6);
}
```

- [ ] **Step 4: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/store/outbox.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0002_outbox.sql src/store/outbox.ts tests/store/outbox.test.ts
git commit -m "feat(outbox): queued delivery rows for paid-order side effects (D20)"
```

---

### Task 7: Message templates (calendar event, customer email, owner email)

**Files:**
- Create: `src/core/messages.ts`
- Modify: `src/core/time.ts` (add `humanDate`, `longDate`), `src/routes/public.ts` (import `humanDate` from core instead of defining it; keep the export)
- Test: `tests/core/messages.test.ts`, `tests/core/time.test.ts` (append)

**Interfaces:**
- Consumes: `Order` (type, `src/store/orders.ts`), `StoreConfig`, `sizeById` (`src/config.ts`), `Mail`, `NewAllDayEvent` (Task 1).
- Produces (in `src/core/messages.ts`): `dollars(cents): string` ("$85.00"), `eventIdFor(orderId): string` ("bb" + uuid hex), `orderEvent(order, cfg, siteUrl): NewAllDayEvent`, `customerEmail(order, cfg): Mail`, `ownerEmail(order, cfg, siteUrl): Mail`.
- Produces (in `src/core/time.ts`): `humanDate(ymd)` → "Wed Sep 9"; `longDate(ymd)` → "Wednesday, September 9".
- Copy is verbatim below and pinned by tests. Changing wording later = edit template + test.

- [ ] **Step 1: Move `humanDate` into core and add `longDate`**

Append to `src/core/time.ts`:

```ts
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Wed Sep 9" */
export function humanDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${DAY[weekdayOf(ymd)]} ${MON[m - 1]} ${d}`;
}

/** "Wednesday, September 9" */
export function longDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${DAY_LONG[weekdayOf(ymd)]}, ${MON_LONG[m - 1]} ${d}`;
}
```

In `src/routes/public.ts`: delete the local `DAY`, `MON` constants and the `humanDate` function; change the time import to
`import { isYmd, weekdayOf, ymdRange, addDays, ymdIn, humanDate } from "../core/time";` (drop `weekdayOf` if nothing else in the file uses it — check with `grep -n weekdayOf src/routes/public.ts`) and add `export { humanDate };` so any existing importer keeps working.

Append to `tests/core/time.test.ts`:

```ts
  it("formats human and long dates", () => {
    expect(humanDate("2026-09-09")).toBe("Wed Sep 9");
    expect(longDate("2026-09-09")).toBe("Wednesday, September 9");
    expect(longDate("2026-11-01")).toBe("Sunday, November 1");
  });
```

(add `humanDate, longDate` to that file's import from `../../src/core/time`).

- [ ] **Step 2: Write the failing message tests**

`tests/core/messages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config";
import type { Order } from "../../src/store/orders";
import { customerEmail, dollars, eventIdFor, orderEvent, ownerEmail } from "../../src/core/messages";

const cfg = loadConfig();
const SITE = "https://thebullandbloom.com";
const order: Order = {
  id: "7a1b2c3d-0000-4000-8000-123456789abc", createdAt: 1, status: "paid", date: "2026-09-09", sizeId: "bouquet",
  fulfillment: "pickup", customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: "518-555-0100",
  addressJson: null, note: "For my mother. Something soft.", stripeSessionId: "cs_1", stripePaymentIntent: "pi_1",
  bouquetCents: 8500, deliveryCents: 0, source: "one_time", holdExpiresAt: null, calendarEventId: null,
};

describe("dollars", () => {
  it("formats cents", () => {
    expect(dollars(8500)).toBe("$85.00");
    expect(dollars(5)).toBe("$0.05");
    expect(dollars(123456)).toBe("$1,234.56");
  });
});

describe("eventIdFor", () => {
  it("is base32hex-safe and derived from the order id (D21)", () => {
    expect(eventIdFor(order.id)).toBe("bb7a1b2c3d000040008000123456789abc");
    expect(eventIdFor(order.id)).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe("orderEvent", () => {
  it("is an all-day event on the order date with the details Anthony needs", () => {
    const ev = orderEvent(order, cfg, SITE);
    expect(ev).toEqual({
      id: eventIdFor(order.id),
      date: "2026-09-09",
      summary: "Bouquet · Pat Smith · pickup",
      description: [
        "Bouquet ($85.00) · pickup",
        "Pat Smith",
        "pat@example.com · 518-555-0100",
        "Note: For my mother. Something soft.",
        "",
        "Order 7a1b2c3d · paid online",
        "https://thebullandbloom.com/admin/#2026-09-09",
      ].join("\n"),
    });
  });
  it("omits the phone and note lines when absent and names unknown sizes by id", () => {
    const ev = orderEvent({ ...order, customerPhone: null, note: null, sizeId: "mystery", bouquetCents: 100 }, cfg, SITE);
    expect(ev.summary).toBe("mystery · Pat Smith · pickup");
    expect(ev.description.split("\n").slice(0, 3)).toEqual(["mystery ($1.00) · pickup", "Pat Smith", "pat@example.com"]);
    expect(ev.description).not.toContain("Note:");
  });
});

describe("customerEmail", () => {
  it("confirms the order in plain text with pickup details", () => {
    const m = customerEmail(order, cfg);
    expect(m.to).toBe("pat@example.com");
    expect(m.subject).toBe("Your Bull and Bloom bouquet for Wed Sep 9");
    expect(m.text).toBe([
      "Hi Pat,",
      "",
      "Thank you. Your Bouquet is booked for pickup on Wednesday, September 9.",
      "",
      `Pickup: ${cfg.studio.pickupInstructions}`,
      `Address: ${cfg.studio.pickupAddress}`,
      "",
      "What you ordered",
      "  Bouquet: $85.00",
      "  Your note: For my mother. Something soft.",
      "",
      "Questions or a change of plans? Just reply to this email.",
      "",
      "Anthony",
      "The Bull and Bloom",
      "thebullandbloom.com",
    ].join("\n"));
  });
  it("uses the first name only and skips the note line when there is none", () => {
    const m = customerEmail({ ...order, customerName: "Pat", note: null }, cfg);
    expect(m.text.startsWith("Hi Pat,\n")).toBe(true);
    expect(m.text).not.toContain("Your note:");
  });
});

describe("ownerEmail", () => {
  it("tells Anthony what to make and links to the day in admin", () => {
    const m = ownerEmail(order, cfg, SITE);
    expect(m.to).toBe(cfg.studio.ownerEmail);
    expect(m.subject).toBe("New order: Bouquet · Pat Smith · Wed Sep 9 (pickup)");
    expect(m.text).toBe([
      "Bouquet ($85.00) · pickup · Wednesday, September 9",
      "",
      "Pat Smith",
      "pat@example.com · 518-555-0100",
      "Note: For my mother. Something soft.",
      "",
      "Order 7a1b2c3d · paid online",
      "https://thebullandbloom.com/admin/#2026-09-09",
    ].join("\n"));
  });
});
```

Run: `npx vitest run tests/core/messages.test.ts tests/core/time.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

`src/core/messages.ts`:

```ts
import type { Mail, NewAllDayEvent } from "../adapters/google";
import type { Order } from "../store/orders";
import { sizeById, type StoreConfig } from "../config";
import { humanDate, longDate } from "./time";

export function dollars(cents: number): string {
  const whole = Math.floor(cents / 100), frac = cents % 100;
  return `$${whole.toLocaleString("en-US")}.${String(frac).padStart(2, "0")}`;
}

/** Google event ids must be 5–1024 chars of [a-v0-9]; a lowercase UUID's hex fits once the hyphens go (D21). */
export function eventIdFor(orderId: string): string {
  return `bb${orderId.toLowerCase().replace(/-/g, "")}`;
}

function sizeName(order: Order, cfg: StoreConfig): string {
  return sizeById(cfg, order.sizeId)?.name ?? order.sizeId;
}
function contactLine(order: Order): string {
  return order.customerPhone ? `${order.customerEmail} · ${order.customerPhone}` : order.customerEmail;
}
function shortId(order: Order): string { return order.id.slice(0, 8); }
function adminLink(order: Order, siteUrl: string): string { return `${siteUrl}/admin/#${order.date}`; }

/** Lines shared by the calendar description and Anthony's email: who, how to reach them, note, order link. */
function detailLines(order: Order, siteUrl: string): string[] {
  const lines = [order.customerName, contactLine(order)];
  if (order.note) lines.push(`Note: ${order.note}`);
  lines.push("", `Order ${shortId(order)} · paid online`, adminLink(order, siteUrl));
  return lines;
}

export function orderEvent(order: Order, cfg: StoreConfig, siteUrl: string): NewAllDayEvent {
  const size = sizeName(order, cfg);
  return {
    id: eventIdFor(order.id),
    date: order.date,
    summary: `${size} · ${order.customerName} · ${order.fulfillment}`,
    description: [`${size} (${dollars(order.bouquetCents)}) · ${order.fulfillment}`, ...detailLines(order, siteUrl)].join("\n"),
  };
}

export function customerEmail(order: Order, cfg: StoreConfig): Mail {
  const size = sizeName(order, cfg);
  const firstName = order.customerName.trim().split(/\s+/)[0];
  const lines = [
    `Hi ${firstName},`,
    "",
    `Thank you. Your ${size} is booked for ${order.fulfillment} on ${longDate(order.date)}.`,
    "",
    `Pickup: ${cfg.studio.pickupInstructions}`,
    `Address: ${cfg.studio.pickupAddress}`,
    "",
    "What you ordered",
    `  ${size}: ${dollars(order.bouquetCents)}`,
  ];
  if (order.note) lines.push(`  Your note: ${order.note}`);
  lines.push("", "Questions or a change of plans? Just reply to this email.", "", "Anthony", "The Bull and Bloom", "thebullandbloom.com");
  return { to: order.customerEmail, subject: `Your Bull and Bloom bouquet for ${humanDate(order.date)}`, text: lines.join("\n") };
}

export function ownerEmail(order: Order, cfg: StoreConfig, siteUrl: string): Mail {
  const size = sizeName(order, cfg);
  return {
    to: cfg.studio.ownerEmail,
    subject: `New order: ${size} · ${order.customerName} · ${humanDate(order.date)} (${order.fulfillment})`,
    text: [`${size} (${dollars(order.bouquetCents)}) · ${order.fulfillment} · ${longDate(order.date)}`, "", ...detailLines(order, siteUrl)].join("\n"),
  };
}
```

The `Order` type does not yet have `calendarEventId`; the test above includes it. Add it now in `src/store/orders.ts`: add `calendarEventId: string | null;` to `Order`, `calendar_event_id: string | null;` to `Row`, `calendar_event_id` to `COLS`, and `calendarEventId: r.calendar_event_id,` to `fromRow`. If an existing test in `tests/store/orders.test.ts` compares a whole `Order` with `toEqual`, add `calendarEventId: null` to its expected object.

- [ ] **Step 4: Run to verify pass, then the whole suite**

Run: `npx vitest run tests/core && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/messages.ts src/core/time.ts src/routes/public.ts src/store/orders.ts tests/core/messages.test.ts tests/core/time.test.ts tests/store/orders.test.ts
git commit -m "feat(messages): calendar event and plain-text confirmation templates"
```

---

### Task 8: Outbox drain job and webhook enqueue

**Files:**
- Create: `src/jobs/outbox.ts`, `src/routes/background.ts`
- Modify: `src/store/orders.ts` (`markPaidBySession` extras, `setCalendarEventId`), `src/routes/webhooks.ts`
- Test: `tests/jobs/outbox.test.ts`, `tests/routes/webhooks.test.ts` (append), `tests/store/orders.test.ts` (append)

**Interfaces:**
- Consumes: `Google`, `GoogleNotConnected` (Task 1); `loadState` (Task 2); outbox store (Task 6); templates (Task 7); `getOrder`.
- Produces:
  - `markPaidBySession(db, sessionId, paymentIntent, extra: D1PreparedStatement[] = [])` — runs the UPDATE and `extra` in ONE `db.batch`; returns the order as before.
  - `setCalendarEventId(db, orderId, eventId): Promise<void>`.
  - `drainOutbox(deps: { db; google; config; siteUrl }, now: Date): Promise<{ status: "skipped" | "ok"; delivered: number; failed: number }>` in `src/jobs/outbox.ts`.
  - `background(c, promise): Promise<void>` in `src/routes/background.ts` — `waitUntil` when an execution context exists, else awaits (tests).
- Delivery rules per kind: `calendar_event` → skip as done if the order already has `calendarEventId`, else insert on `state.ordersCalendarId` and store the id. `email_customer` → `customerEmail`. `email_owner` → `ownerEmail`. An item whose order is missing or no longer `paid`/`done` is marked done without sending. Failure → `attempts + 1`, `backoff`, `markFailed`, `console.error`. Not connected (no state) → return `skipped` without touching rows, so attempts are not burned before Anthony connects.

- [ ] **Step 1: Store changes with tests**

Append to `tests/store/orders.test.ts` (import `markPaidBySession`, `setCalendarEventId`, `getOrder` if not already):

```ts
describe("markPaidBySession extras and calendar id", () => {
  it("runs extra statements in the same batch as the flip", async () => {
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id, hold_expires_at)
       VALUES ('px1', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, 'cs_px1', 99)`,
    ).run();
    const marker = env.DB.prepare("INSERT INTO settings (key, value_json) VALUES ('test.px1', '1')");
    const o = await markPaidBySession(env.DB, "cs_px1", "pi_px1", [marker]);
    expect(o?.status).toBe("paid");
    expect(await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'test.px1'").first()).toEqual({ value_json: "1" });
    await env.DB.prepare("DELETE FROM settings WHERE key = 'test.px1'").run();
    // a duplicate flip changes nothing and returns null; callers guard their extras (outbox uses INSERT OR IGNORE + a status check)
    expect(await markPaidBySession(env.DB, "cs_px1", "pi_px1")).toBeNull();
  });
  it("stores the calendar event id", async () => {
    await setCalendarEventId(env.DB, "px1", "bbpx1");
    expect((await getOrder(env.DB, "px1"))?.calendarEventId).toBe("bbpx1");
  });
});
```

Change `markPaidBySession` in `src/store/orders.ts` to:

```ts
export async function markPaidBySession(
  db: D1Database, sessionId: string, paymentIntent: string, extra: D1PreparedStatement[] = [],
): Promise<Order | null> {
  const [upd] = await db.batch([
    db.prepare(
      `UPDATE orders SET status = 'paid', stripe_payment_intent = ?, hold_expires_at = NULL
       WHERE stripe_session_id = ? AND status IN ('held', 'cancelled')`,
    ).bind(paymentIntent, sessionId),
    ...extra,
  ]);
  if (upd.meta.changes !== 1) return null;
  const r = await db.prepare(`SELECT ${COLS} FROM orders WHERE stripe_session_id = ?`).bind(sessionId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function setCalendarEventId(db: D1Database, orderId: string, eventId: string): Promise<void> {
  await db.prepare("UPDATE orders SET calendar_event_id = ? WHERE id = ?").bind(eventId, orderId).run();
}
```

Run: `npx vitest run tests/store/orders.test.ts` — expected PASS.

- [ ] **Step 2: Write the failing job tests**

`tests/jobs/outbox.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { drainOutbox } from "../../src/jobs/outbox";
import { ORDER_PAID_KINDS, counts, enqueueForSessionStatements } from "../../src/store/outbox";
import { clearConnection, saveState } from "../../src/store/google";
import { loadConfig } from "../../src/config";
import { FakeGoogle } from "../fakes/google";

const NOW = new Date("2026-09-08T14:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const STATE = { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 };
const cfg = loadConfig();

async function paidOrder(id: string, session: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, customer_phone, note, bouquet_cents, stripe_session_id)
     VALUES (?, 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'Pat Smith', 'pat@example.com', NULL, NULL, 8500, ?)`,
  ).bind(id, session).run();
  await env.DB.batch(enqueueForSessionStatements(env.DB, session, ORDER_PAID_KINDS, NOW_SEC));
}
const deps = (google: FakeGoogle) => ({ db: env.DB, google, config: cfg, siteUrl: "https://x.test" });

describe("drainOutbox", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
  });

  it("skips without touching rows when Google is not connected", async () => {
    await paidOrder("d1", "cs_d1");
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "skipped", delivered: 0, failed: 0 });
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
    const row = await env.DB.prepare("SELECT attempts FROM outbox WHERE order_id = 'd1' LIMIT 1").first<any>();
    expect(row.attempts).toBe(0);
  });

  it("creates the calendar event, stores its id, and sends both emails", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d2", "cs_d2");
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 3, failed: 0 });
    expect(g.inserted).toHaveLength(1);
    expect(g.inserted[0].calendarId).toBe("cal_orders");
    expect(g.inserted[0].event.summary).toBe("Bouquet · Pat Smith · pickup");
    expect(g.inserted[0].event.date).toBe("2026-09-09");
    const o = await env.DB.prepare("SELECT calendar_event_id FROM orders WHERE id = 'd2'").first<any>();
    expect(o.calendar_event_id).toBe("bbd2");
    expect(g.sent.map((m) => m.to).sort()).toEqual(["pat@example.com", cfg.studio.ownerEmail].sort());
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    // second drain: nothing due, nothing sent again
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
    expect(g.sent).toHaveLength(2);
  });

  it("does not insert a second event when the order already has one", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d3", "cs_d3");
    await env.DB.prepare("UPDATE orders SET calendar_event_id = 'already' WHERE id = 'd3'").run();
    const g = new FakeGoogle();
    await drainOutbox(deps(g), NOW);
    expect(g.inserted).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
  });

  it("records a failure with backoff and retries later", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d4", "cs_d4");
    const g = new FakeGoogle();
    g.failNext = "gmail 500";
    const r = await drainOutbox(deps(g), NOW);
    expect(r).toEqual({ status: "ok", delivered: 2, failed: 1 });
    const failed = await env.DB.prepare("SELECT kind, attempts, next_attempt_at, last_error FROM outbox WHERE order_id = 'd4' AND done_at IS NULL").first<any>();
    expect(failed).toEqual({ kind: "calendar_event", attempts: 1, next_attempt_at: NOW_SEC + 120, last_error: "gmail 500" });
    expect(await drainOutbox(deps(g), new Date((NOW_SEC + 60) * 1000))).toEqual({ status: "ok", delivered: 0, failed: 0 });
    expect(await drainOutbox(deps(g), new Date((NOW_SEC + 120) * 1000))).toEqual({ status: "ok", delivered: 1, failed: 0 });
    expect(g.inserted).toHaveLength(1);
  });

  it("gives up after the 24th failed attempt", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d5", "cs_d5");
    await env.DB.prepare("UPDATE outbox SET attempts = 23 WHERE order_id = 'd5' AND kind = 'email_owner'").run();
    await env.DB.prepare("DELETE FROM outbox WHERE order_id = 'd5' AND kind != 'email_owner'").run();
    const g = new FakeGoogle();
    g.failNext = "still down";
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 1 });
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 1 });
  });

  it("marks items done without sending when the order is no longer paid or done", async () => {
    await saveState(env.DB, STATE);
    await paidOrder("d6", "cs_d6");
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = 'd6'").run();
    const g = new FakeGoogle();
    expect(await drainOutbox(deps(g), NOW)).toEqual({ status: "ok", delivered: 0, failed: 0 });
    expect(g.sent).toHaveLength(0);
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
  });
});
```

Run: `npx vitest run tests/jobs/outbox.test.ts` — expected FAIL (module not found).

- [ ] **Step 3: Implement the job**

`src/jobs/outbox.ts`:

```ts
import type { Google } from "../adapters/google";
import type { StoreConfig } from "../config";
import { customerEmail, orderEvent, ownerEmail } from "../core/messages";
import { loadState, type GoogleState } from "../store/google";
import { getOrder, setCalendarEventId, type Order } from "../store/orders";
import { backoff, dueItems, markDone, markFailed, type OutboxItem } from "../store/outbox";

export interface OutboxDeps { db: D1Database; google: Google; config: StoreConfig; siteUrl: string }
export interface DrainResult { status: "skipped" | "ok"; delivered: number; failed: number }

/** Deliver every due outbox row once. Failures are rescheduled with backoff; nothing here throws. */
export async function drainOutbox(deps: OutboxDeps, now: Date): Promise<DrainResult> {
  const state = await loadState(deps.db);
  if (!state) return { status: "skipped", delivered: 0, failed: 0 };
  const nowSec = Math.floor(now.getTime() / 1000);
  let delivered = 0, failed = 0;
  for (const item of await dueItems(deps.db, nowSec)) {
    try {
      await deliver(deps, state, item);
      await markDone(deps.db, item.id, nowSec);
      delivered++;
    } catch (e) {
      const attempts = item.attempts + 1;
      const next = backoff(attempts, nowSec);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`outbox: ${item.kind} for order ${item.orderId} failed (attempt ${attempts}${next === null ? ", giving up" : ""})`, msg);
      await markFailed(deps.db, item.id, attempts, next, msg);
      failed++;
    }
  }
  return { status: "ok", delivered, failed };
}

async function deliver(deps: OutboxDeps, state: GoogleState, item: OutboxItem): Promise<void> {
  const order = await getOrder(deps.db, item.orderId);
  if (!order || (order.status !== "paid" && order.status !== "done")) {
    console.error(`outbox: order ${item.orderId} is ${order?.status ?? "missing"}; dropping ${item.kind}`);
    return;
  }
  switch (item.kind) {
    case "calendar_event": return calendarEvent(deps, state, order);
    case "email_customer": return deps.google.sendMail(customerEmail(order, deps.config));
    case "email_owner": return deps.google.sendMail(ownerEmail(order, deps.config, deps.siteUrl));
  }
}

async function calendarEvent(deps: OutboxDeps, state: GoogleState, order: Order): Promise<void> {
  if (order.calendarEventId) return;
  const id = await deps.google.insertAllDayEvent(state.ordersCalendarId, orderEvent(order, deps.config, deps.siteUrl));
  await setCalendarEventId(deps.db, order.id, id);
}
```

Run: `npx vitest run tests/jobs/outbox.test.ts` — expected PASS.

- [ ] **Step 4: Hook the webhook**

`src/routes/background.ts`:

```ts
import type { Context } from "hono";

/** Run `work` after the response when the runtime gives us an ExecutionContext; otherwise (tests) await it. */
export function background(c: Context, work: Promise<unknown>): Promise<void> {
  const guarded = work.then(() => undefined, (e) => { console.error("background job failed", e); });
  let ctx: ExecutionContext | undefined;
  try { ctx = c.executionCtx; } catch { ctx = undefined; } // Hono throws when there is none
  if (ctx) { ctx.waitUntil(guarded); return Promise.resolve(); }
  return guarded;
}
```

`src/routes/webhooks.ts` — replace the `checkout.session.completed` branch:

```ts
    if (event.type === "checkout.session.completed") {
      const nowSec = Math.floor(clock().getTime() / 1000);
      const order = await markPaidBySession(
        c.env.DB, event.sessionId, event.paymentIntent,
        enqueueForSessionStatements(c.env.DB, event.sessionId, ORDER_PAID_KINDS, nowSec),
      );
      if (!order) console.error("webhook: completed but no held order for session", event.sessionId);
      else await background(c, drainOutbox({ db: c.env.DB, google, config, siteUrl: c.env.SITE_URL }, clock()));
      return c.json({ received: true, applied: order ? "paid" : "ignored" });
    }
```

with `const { payments, google, config, clock } = c.get("services");` at the top of the handler and these imports added:

```ts
import { enqueueForSessionStatements, ORDER_PAID_KINDS } from "../store/outbox";
import { drainOutbox } from "../jobs/outbox";
import { background } from "./background";
```

Append to `tests/routes/webhooks.test.ts` (add imports: `saveState, clearConnection` from `../../src/store/google`; `counts` from `../../src/store/outbox`):

```ts
describe("POST /webhooks/stripe → outbox", () => {
  it("enqueues three deliveries with the paid flip and delivers them when Google is connected", async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await heldOrder("w5", "cs_w5");
    const { fetch, payments, google } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_w5", paymentIntent: "pi_w5" };
    // not connected: rows wait, webhook still 200
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paid" });
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
    expect(google.sent).toHaveLength(0);
    // connect and let a duplicate webhook through: no new rows, no delivery from the duplicate path
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
  });
  it("delivers immediately when connected and keeps the webhook 200 when Google fails", async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    await heldOrder("w6", "cs_w6");
    const { fetch, payments, google } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_w6", paymentIntent: "pi_w6" };
    google.failNext = "calendar down";
    const r = await hook(fetch);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, applied: "paid" });
    expect(google.inserted).toHaveLength(0);
    expect(google.sent).toHaveLength(2);
    expect(await counts(env.DB)).toEqual({ pending: 1, failed: 0 });
    const row = await env.DB.prepare("SELECT status FROM orders WHERE id = 'w6'").first<any>();
    expect(row.status).toBe("paid");
  });
});
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/outbox.ts src/routes/background.ts src/routes/webhooks.ts src/store/orders.ts tests/jobs/outbox.test.ts tests/routes/webhooks.test.ts tests/store/orders.test.ts
git commit -m "feat(outbox): deliver calendar events and emails for paid orders, with retry"
```

---

### Task 9: Scheduled orchestrator (expire holds, sync blackouts, drain outbox)

**Files:**
- Modify: `src/scheduled.ts`
- Test: `tests/scheduled.test.ts` (extend)

**Interfaces:**
- Consumes: `syncBlackouts` (Task 5), `drainOutbox` (Task 8), `Services`.
- Produces: `runScheduled(env, services, now): Promise<ScheduledReport>` where
  `interface ScheduledReport { expiredHolds: number | { error: string }; blackouts: BlackoutSyncResult | { status: "error"; error: string }; outbox: DrainResult | { status: "error"; error: string } }`. Each job is isolated: one throwing never stops the others.

- [ ] **Step 1: Extend the test**

Replace `tests/scheduled.test.ts` with:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { runScheduled } from "../src/scheduled";
import { clearConnection, saveState } from "../src/store/google";
import { testServices } from "./helpers";

const ORDER = `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, hold_expires_at)
  VALUES (?, 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'A', 'a@example.com', 8500, ?)`;

describe("runScheduled", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
  });

  it("expires stale holds and reports the Google jobs as skipped when not connected", async () => {
    const now = 1_800_000_000;
    await env.DB.batch([env.DB.prepare(ORDER).bind("s1", now - 1), env.DB.prepare(ORDER).bind("s2", now + 600)]);
    const { services } = testServices();
    expect(await runScheduled(env, services, new Date(now * 1000))).toEqual({
      expiredHolds: 1,
      blackouts: { status: "skipped" },
      outbox: { status: "skipped", delivered: 0, failed: 0 },
    });
    const s = await env.DB.prepare("SELECT id, status FROM orders WHERE id IN ('s1','s2') ORDER BY id").all<any>();
    expect(s.results).toEqual([{ id: "s1", status: "cancelled" }, { id: "s2", status: "held" }]);
  });

  it("runs blackout sync and outbox drain when connected, isolating a failure", async () => {
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 });
    const { services, google } = testServices();
    google.events["cal_closed"] = [{ id: "v", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } }];
    google.failNext = "listEvents exploded";
    const r = await runScheduled(env, services, new Date("2026-09-08T14:00:00Z"));
    expect(r.expiredHolds).toBe(0);
    expect(r.blackouts).toEqual({ status: "error", error: "listEvents exploded" });
    expect(r.outbox).toEqual({ status: "ok", delivered: 0, failed: 0 });
    const r2 = await runScheduled(env, services, new Date("2026-09-08T14:15:00Z"));
    expect(r2.blackouts).toEqual({ status: "ok", added: 1, removed: 0, closed: 1 });
  });
});
```

Run: `npx vitest run tests/scheduled.test.ts` — expected FAIL (report shape).

- [ ] **Step 2: Implement**

Replace `src/scheduled.ts` with:

```ts
import type { Env } from "./env";
import type { Services } from "./app";
import { expireHolds } from "./store/orders";
import { syncBlackouts, type BlackoutSyncResult } from "./jobs/blackouts";
import { drainOutbox, type DrainResult } from "./jobs/outbox";

type Failed = { status: "error"; error: string };
export interface ScheduledReport {
  expiredHolds: number | { error: string };
  blackouts: BlackoutSyncResult | Failed;
  outbox: DrainResult | Failed;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every 15 minutes (wrangler.toml). Each job is isolated so one failure never blocks the others. */
export async function runScheduled(env: Env, services: Services, now: Date): Promise<ScheduledReport> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const { google, config } = services;

  let expiredHolds: ScheduledReport["expiredHolds"];
  try { expiredHolds = await expireHolds(env.DB, nowSec); }
  catch (e) { console.error("scheduled: expireHolds failed", e); expiredHolds = { error: msg(e) }; }

  let blackouts: ScheduledReport["blackouts"];
  try { blackouts = await syncBlackouts(env.DB, google, config.timezone, now); }
  catch (e) { console.error("scheduled: syncBlackouts threw", e); blackouts = { status: "error", error: msg(e) }; }

  let outbox: ScheduledReport["outbox"];
  try { outbox = await drainOutbox({ db: env.DB, google, config, siteUrl: env.SITE_URL }, now); }
  catch (e) { console.error("scheduled: drainOutbox threw", e); outbox = { status: "error", error: msg(e) }; }

  return { expiredHolds, blackouts, outbox };
}
```

- [ ] **Step 3: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/scheduled.ts tests/scheduled.test.ts
git commit -m "feat(cron): run blackout sync and outbox drain alongside hold expiry"
```

---

### Task 10: Admin API for Google (status, connect, callback, disconnect, sync, retry)

**Files:**
- Create: `src/routes/admin-google.ts`
- Modify: `src/routes/admin.ts` (call `registerGoogleAdmin(r)` at the end, before `return r`)
- Test: `tests/routes/admin-google.test.ts`

**Interfaces:**
- Consumes: `makeSession`, `verifySession` (`src/admin/session.ts`); `Google` (Task 1); store/google (Task 2); `syncBlackouts` (Task 5); outbox `counts`, `retryFailed` (Task 6); `drainOutbox` (Task 8).
- Produces: `registerGoogleAdmin(r: App): void` adding
  - `GET /admin/api/google/status` → `{ configured, connected, account, calendars: { closed, orders } | null, connectedAt, lastSyncAt, lastSyncError, outbox: { pending, failed } }`
  - `GET /admin/api/google/start` → 302 to Google consent (503 JSON `{ error: "google_not_configured" }` when the client secrets are absent)
  - `GET /admin/google/callback` (outside `/admin/api/*`, so no cookie check; D25) → 302 to `/admin/?google=connected|denied|failed`, or 400 on a bad `state`
  - `POST /admin/api/google/disconnect` → 204
  - `POST /admin/api/google/sync` → `BlackoutSyncResult` JSON
  - `POST /admin/api/google/retry` → `{ retried: number, drain: DrainResult }`
- Redirect URI is `${SITE_URL}/admin/google/callback`. The `state` is `makeSession(stateSecret, now, 600)` with `stateSecret = ADMIN_SECRET + ":oauth-state"`, verified with `verifySession`.
- `connected` in status is true only when state exists AND the stored token decrypts (so a rotated `ADMIN_SECRET` shows as disconnected).

- [ ] **Step 1: Write the failing tests**

`tests/routes/admin-google.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp } from "../helpers";
import { clearConnection, loadState, loadConnection, saveState, saveConnection } from "../../src/store/google";
import { ORDER_PAID_KINDS, counts, enqueueForSessionStatements } from "../../src/store/outbox";

async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  expect(r.status).toBe(204);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" }, redirect: "manual" });
}
const NOW = new Date("2026-09-08T14:00:00Z");

describe("admin google", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
  });

  it("requires the admin cookie for the api routes", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/google/status")).status).toBe(401);
    expect((await fetch("/admin/api/google/start")).status).toBe(401);
    expect((await fetch("/admin/api/google/sync", { method: "POST" })).status).toBe(401);
  });

  it("reports not connected, then connects through start → callback and creates both calendars", async () => {
    const { fetch, google } = testApp(NOW);
    const api = await login(fetch);
    expect(await (await api("/admin/api/google/status")).json()).toEqual({
      configured: true, connected: false, account: null, calendars: null, connectedAt: null,
      lastSyncAt: null, lastSyncError: null, outbox: { pending: 0, failed: 0 },
    });

    const start = await api("/admin/api/google/start");
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    expect(loc.origin).toBe("https://accounts.google.test");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${env.SITE_URL}/admin/google/callback`);
    const state = loc.searchParams.get("state")!;

    // the callback arrives WITHOUT the cookie (SameSite=Strict, D25)
    const cb = await fetch(`/admin/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/admin/?google=connected");
    expect(await loadConnection(env.DB, env.ADMIN_SECRET)).toEqual({ refreshToken: "rt_fake", account: "thebullandbloom@gmail.com" });
    expect(await loadState(env.DB)).toEqual({
      account: "thebullandbloom@gmail.com", closedCalendarId: "cal_1", ordersCalendarId: "cal_2", connectedAt: Math.floor(NOW.getTime() / 1000),
    });
    expect([...google.calendars.keys()]).toEqual(["Bull and Bloom: Closed", "Bull and Bloom: Orders"]);

    const status = await (await api("/admin/api/google/status")).json();
    expect(status).toMatchObject({ connected: true, account: "thebullandbloom@gmail.com", calendars: { closed: "cal_1", orders: "cal_2" } });
  });

  it("rejects a forged or expired state and reports denial", async () => {
    const { fetch } = testApp(NOW);
    expect((await fetch("/admin/google/callback?code=good-code&state=999.forged", { redirect: "manual" })).status).toBe(400);
    expect((await fetch("/admin/google/callback?code=good-code", { redirect: "manual" })).status).toBe(400);
    const api = await login(fetch);
    const state = new URL((await api("/admin/api/google/start")).headers.get("location")!).searchParams.get("state")!;
    const late = testApp(new Date(NOW.getTime() + 11 * 60_000));
    expect((await late.fetch(`/admin/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: "manual" })).status).toBe(400);
    const denied = await fetch(`/admin/google/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(denied.headers.get("location")).toBe("/admin/?google=denied");
    expect(await loadState(env.DB)).toBeNull();
  });

  it("redirects to failed when the code exchange fails, leaving nothing stored", async () => {
    const { fetch } = testApp(NOW);
    const api = await login(fetch);
    const state = new URL((await api("/admin/api/google/start")).headers.get("location")!).searchParams.get("state")!;
    const cb = await fetch(`/admin/google/callback?code=bad-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.headers.get("location")).toBe("/admin/?google=failed");
    expect(await loadState(env.DB)).toBeNull();
  });

  it("returns 503 from start when the client is not configured", async () => {
    const { fetch, google } = testApp(NOW);
    google.isConfigured = false;
    const api = await login(fetch);
    expect((await api("/admin/api/google/start")).status).toBe(503);
    expect((await (await api("/admin/api/google/status")).json()).configured).toBe(false);
  });

  it("shows disconnected when the stored token no longer decrypts", async () => {
    await saveConnection(env.DB, "some-other-secret", { refreshToken: "rt", account: "a@b.c" });
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 1 });
    const { fetch } = testApp(NOW);
    const api = await login(fetch);
    expect((await (await api("/admin/api/google/status")).json()).connected).toBe(false);
  });

  it("syncs on demand, disconnects, and retries failed outbox rows", async () => {
    await saveConnection(env.DB, env.ADMIN_SECRET, { refreshToken: "rt", account: "a@b.c" });
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 });
    const { fetch, google } = testApp(NOW);
    const api = await login(fetch);
    google.events["cal_closed"] = [{ id: "v", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } }];
    expect(await (await api("/admin/api/google/sync", { method: "POST" })).json()).toEqual({ status: "ok", added: 1, removed: 0, closed: 1 });
    expect((await (await api("/admin/api/google/status")).json()).lastSyncAt).toBe(Math.floor(NOW.getTime() / 1000));

    await env.DB.prepare(
      `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id)
       VALUES ('ag1', 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, 'cs_ag1')`).run();
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_ag1", ORDER_PAID_KINDS, 1));
    await env.DB.prepare("UPDATE outbox SET next_attempt_at = NULL, attempts = 24 WHERE order_id = 'ag1'").run();
    expect((await (await api("/admin/api/google/status")).json()).outbox).toEqual({ pending: 0, failed: 3 });
    expect(await (await api("/admin/api/google/retry", { method: "POST" })).json()).toEqual({ retried: 3, drain: { status: "ok", delivered: 3, failed: 0 } });
    expect(await counts(env.DB)).toEqual({ pending: 0, failed: 0 });
    expect(google.sent).toHaveLength(2);

    expect((await api("/admin/api/google/disconnect", { method: "POST" })).status).toBe(204);
    expect(await loadState(env.DB)).toBeNull();
    expect((await (await api("/admin/api/google/status")).json()).connected).toBe(false);
  });
});
```

Run: `npx vitest run tests/routes/admin-google.test.ts` — expected FAIL (404s).

- [ ] **Step 2: Implement**

`src/routes/admin-google.ts`:

```ts
import type { App } from "../app";
import { makeSession, verifySession } from "../admin/session";
import { clearConnection, loadConnection, loadState, loadSync, saveConnection, saveState } from "../store/google";
import { counts, retryFailed } from "../store/outbox";
import { syncBlackouts } from "../jobs/blackouts";
import { drainOutbox } from "../jobs/outbox";

const STATE_TTL = 600; // seconds a consent round-trip may take
const stateSecret = (adminSecret: string) => `${adminSecret}:oauth-state`;
const redirectUri = (siteUrl: string) => `${siteUrl}/admin/google/callback`;

/** Mounted from adminRoutes() AFTER its cookie middleware, so /admin/api/google/* is protected and /admin/google/callback is not (D25). */
export function registerGoogleAdmin(r: App): void {
  r.get("/admin/api/google/status", async (c) => {
    const { google } = c.get("services");
    const [state, conn, sync, box] = await Promise.all([
      loadState(c.env.DB), loadConnection(c.env.DB, c.env.ADMIN_SECRET), loadSync(c.env.DB), counts(c.env.DB),
    ]);
    const connected = state !== null && conn !== null;
    return c.json({
      configured: google.configured(),
      connected,
      account: connected ? state.account : null,
      calendars: connected ? { closed: state.closedCalendarId, orders: state.ordersCalendarId } : null,
      connectedAt: connected ? state.connectedAt : null,
      lastSyncAt: sync.at,
      lastSyncError: sync.error,
      outbox: box,
    });
  });

  r.get("/admin/api/google/start", async (c) => {
    const { google, clock } = c.get("services");
    if (!google.configured()) return c.json({ error: "google_not_configured" }, 503);
    const nowSec = Math.floor(clock().getTime() / 1000);
    const state = await makeSession(stateSecret(c.env.ADMIN_SECRET), nowSec, STATE_TTL);
    return c.redirect(google.authUrl(state, redirectUri(c.env.SITE_URL)), 302);
  });

  r.get("/admin/google/callback", async (c) => {
    const { google, clock, config } = c.get("services");
    const nowSec = Math.floor(clock().getTime() / 1000);
    const state = c.req.query("state");
    if (!(await verifySession(state, stateSecret(c.env.ADMIN_SECRET), nowSec))) return c.text("bad or expired state", 400);
    if (c.req.query("error")) return c.redirect("/admin/?google=denied", 302);
    const code = c.req.query("code");
    if (!code) return c.text("missing code", 400);
    try {
      const conn = await google.exchangeCode(code, redirectUri(c.env.SITE_URL));
      await saveConnection(c.env.DB, c.env.ADMIN_SECRET, conn);
      const closedCalendarId = await google.ensureCalendar(config.calendars.closed, config.timezone);
      const ordersCalendarId = await google.ensureCalendar(config.calendars.orders, config.timezone);
      await saveState(c.env.DB, { account: conn.account, closedCalendarId, ordersCalendarId, connectedAt: nowSec });
      return c.redirect("/admin/?google=connected", 302);
    } catch (e) {
      console.error("google: connect failed", e);
      await clearConnection(c.env.DB);
      return c.redirect("/admin/?google=failed", 302);
    }
  });

  r.post("/admin/api/google/disconnect", async (c) => {
    await clearConnection(c.env.DB);
    return c.body(null, 204);
  });

  r.post("/admin/api/google/sync", async (c) => {
    const { google, clock, config } = c.get("services");
    return c.json(await syncBlackouts(c.env.DB, google, config.timezone, clock()));
  });

  r.post("/admin/api/google/retry", async (c) => {
    const { google, clock, config } = c.get("services");
    const now = clock();
    const retried = await retryFailed(c.env.DB, Math.floor(now.getTime() / 1000));
    const drain = await drainOutbox({ db: c.env.DB, google, config, siteUrl: c.env.SITE_URL }, now);
    return c.json({ retried, drain });
  });
}
```

In `src/routes/admin.ts` add `import { registerGoogleAdmin } from "./admin-google";` and, immediately before the final `return r;` in `adminRoutes()`, the line `registerGoogleAdmin(r);`.

- [ ] **Step 3: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS. If the "requires the admin cookie" test gets 404 instead of 401 for `/admin/api/google/start`, the cookie middleware ran but the route was registered before it: confirm `registerGoogleAdmin(r)` is called after `r.use("/admin/api/*", …)`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin-google.ts src/routes/admin.ts tests/routes/admin-google.test.ts
git commit -m "feat(admin): Google connect, status, sync, disconnect, and outbox retry endpoints"
```

---

### Task 11: Admin page Google panel and day deep link

**Files:**
- Modify: `site/admin/index.html`

No unit test harness covers the static page (Plan 1 convention); verification is by hand in Step 3 against `npm run dev`. Keep ES5 style.

- [ ] **Step 1: Markup**

In the toolbar `div.row` add a button between Settings and Sign out:

```html
      <button id="google-btn">Google</button>
```

After the settings panel add:

```html
    <div class="panel" id="google-panel" hidden>
      <h2 style="margin:0 0 .5rem;font-size:1.1rem;font-weight:500">Google calendar and email</h2>
      <p id="g-summary" class="status"></p>
      <div class="row">
        <button id="g-connect" hidden>Connect Google</button>
        <button id="g-sync" hidden>Check the Closed calendar now</button>
        <button id="g-retry" hidden>Retry waiting messages</button>
        <button id="g-disconnect" hidden>Disconnect</button>
        <span class="status" id="g-status"></span>
      </div>
      <p class="status">Close a day by adding any event to the calendar named “Bull and Bloom: Closed”. Paid orders appear on “Bull and Bloom: Orders” and are emailed to you and the customer.</p>
    </div>
```

- [ ] **Step 2: Script**

Inside the IIFE, after `loadSettings`, add:

```js
  function ago(sec) {
    if (!sec) return 'never';
    var m = Math.round((Date.now() / 1000 - sec) / 60);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function loadGoogle() {
    $('#google-panel').hidden = false; $('#day-panel').hidden = true; $('#settings-panel').hidden = true;
    return api('/google/status').then(function (s) {
      var text;
      if (!s.configured) text = 'Not set up yet (Ryan needs to add the Google client keys).';
      else if (!s.connected) text = 'Not connected. Connect while signed in to Google as the shop account.';
      else text = 'Connected as ' + s.account + '. Closed calendar last checked ' + ago(s.lastSyncAt) +
        (s.lastSyncError ? ' (last check failed: ' + s.lastSyncError + ')' : '') + '.' +
        (s.outbox.pending ? ' ' + s.outbox.pending + ' message(s) waiting to send.' : '') +
        (s.outbox.failed ? ' ' + s.outbox.failed + ' message(s) could not be sent.' : '');
      $('#g-summary').textContent = text;
      $('#g-connect').hidden = !(s.configured && !s.connected);
      $('#g-sync').hidden = !s.connected;
      $('#g-disconnect').hidden = !s.connected;
      $('#g-retry').hidden = !(s.connected && s.outbox.failed > 0);
    });
  }
  $('#google-btn').addEventListener('click', loadGoogle);
  $('#g-connect').addEventListener('click', function () { window.location.href = '/admin/api/google/start'; });
  $('#g-sync').addEventListener('click', function () {
    $('#g-status').textContent = 'Checking…';
    api('/google/sync', { method: 'POST' }).then(function (r) {
      $('#g-status').textContent = r.status === 'ok' ? 'Done: ' + r.closed + ' closed day(s) in the next 90 days.' : (r.error || r.status);
      return loadMonth();
    }).then(loadGoogle).catch(function (e) { $('#g-status').textContent = e.message; });
  });
  $('#g-retry').addEventListener('click', function () {
    $('#g-status').textContent = 'Sending…';
    api('/google/retry', { method: 'POST' }).then(function (r) {
      $('#g-status').textContent = 'Sent ' + r.drain.delivered + ', still failing ' + r.drain.failed + '.';
    }).then(loadGoogle).catch(function (e) { $('#g-status').textContent = e.message; });
  });
  $('#g-disconnect').addEventListener('click', function () {
    api('/google/disconnect', { method: 'POST' }).then(loadGoogle).catch(function (e) { $('#g-status').textContent = e.message; });
  });
```

Make the other panel openers hide the Google panel: in `loadDay` and `loadSettings`, add `$('#google-panel').hidden = true;` next to the existing hidden toggles.

Replace the final bootstrap line (`api('/settings').then(function () { show(true); loadMonth(); }).catch(function () { show(false); });`) with:

```js
  var hashDate = /^#(\d{4})-(\d{2})-(\d{2})$/.exec(location.hash);
  if (hashDate) { view = new Date(Number(hashDate[1]), Number(hashDate[2]) - 1, 1); selected = location.hash.slice(1); }
  var flash = /[?&]google=(\w+)/.exec(location.search);
  api('/settings').then(function () {
    show(true);
    return loadMonth();
  }).then(function () {
    if (selected) loadDay();
    if (flash) {
      loadGoogle().then(function () {
        $('#g-status').textContent = flash[1] === 'connected' ? 'Connected.' : flash[1] === 'denied' ? 'Google access was declined.' : 'Connecting failed; try again.';
      });
      history.replaceState(null, '', '/admin/');
    }
  }).catch(function () { show(false); });
```

- [ ] **Step 3: Verify by hand**

Run `npm run dev` (needs `.dev.vars` with the four Plan 1 secrets; Google keys may be absent). Open `http://localhost:8787/admin/`, sign in, press Google: the panel says "Not set up yet" when keys are absent, or "Not connected" with a Connect button when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are in `.dev.vars`. Open `http://localhost:8787/admin/#2026-09-09`: the month shows September and the 9th is selected with its orders panel open. Run `npm test` to confirm nothing else moved.

- [ ] **Step 4: Commit**

```bash
git add site/admin/index.html
git commit -m "feat(admin): Google panel (connect, sync, retry) and #date deep link"
```

---

### Task 12: Google Cloud setup, preview deploy, and acceptance

**Files:**
- Create: `scripts/google-setup.sh`
- Modify: `README.md`, `docs/superpowers/specs/2026-09-07-store-design.md` (§3 D18–D25, §8, §9)

This task is mostly console clicks and commands and stays in the main session with Ryan. Credentialed commands run through Ryan's terminal (`! npx wrangler login` if the session lapsed). Nothing here touches DNS.

- [x] **Step 1: Resolve the pending decisions**

Ryan answers the four items in "Pending decisions for Ryan" at the top of this plan (owner account, who clicks Connect, email copy, event title). Copy or title changes go into `src/core/messages.ts` and its test before continuing.

- [x] **Step 2: Google Cloud console (one time, ~15 minutes)**

Signed in as the account chosen in Step 1, at https://console.cloud.google.com:

1. Create project `bull-and-bloom-store`.
2. APIs & Services → Library: enable **Google Calendar API** and **Gmail API**.
3. APIs & Services → OAuth consent screen (Google Auth Platform → Branding): user type **External**; app name "The Bull and Bloom store"; support email and developer contact = Ryan's; no logo (a logo triggers brand verification).
4. Google Auth Platform → Data Access: add scopes `.../auth/calendar`, `.../auth/gmail.send`, `openid`, `.../auth/userinfo.email`.
5. Google Auth Platform → Audience: **Publish app** to "In production" (D22). Confirm the dialog that mentions verification; the app keeps working unverified with an interstitial.
6. Clients → Create client: type **Web application**, name "store worker". Authorized redirect URIs: `https://thebullandbloom.thebullandbloom.workers.dev/admin/google/callback` AND `https://thebullandbloom.com/admin/google/callback` (the second is for cutover; add it now so nothing needs a console visit later). Copy the client id and secret.
7. Append to `.dev.vars` (gitignored; never paste these into chat):

```
GOOGLE_CLIENT_ID=….apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-…
```

- [x] **Step 3: Write and run the setup script**

`scripts/google-setup.sh`:

```bash
#!/usr/bin/env bash
# One-shot Google wiring for the deployed Worker (Plan 2 Task 12). Reads the OAuth client id and
# secret from .dev.vars, uploads them as Cloudflare secrets, applies the outbox migration remotely,
# and redeploys with SITE_URL pointed at the preview so the OAuth redirect URI matches.
# Usage: scripts/google-setup.sh [preview-url]
set -euo pipefail
cd "$(dirname "$0")/.."

PREVIEW="${1:-https://thebullandbloom.thebullandbloom.workers.dev}"

[ -f .dev.vars ] || { echo "no .dev.vars — add GOOGLE_CLIENT_ID=… and GOOGLE_CLIENT_SECRET=…" >&2; exit 2; }
CID=$(sed -n 's/^GOOGLE_CLIENT_ID=//p' .dev.vars | tr -d '"'"'"' \r')
CSEC=$(sed -n 's/^GOOGLE_CLIENT_SECRET=//p' .dev.vars | tr -d '"'"'"' \r')
case "$CID" in *.apps.googleusercontent.com) ;; *) echo ".dev.vars GOOGLE_CLIENT_ID is missing or not a Google client id" >&2; exit 2 ;; esac
[ -n "$CSEC" ] || { echo ".dev.vars GOOGLE_CLIENT_SECRET is missing" >&2; exit 2; }

echo "→ applying migrations to the production D1 (adds outbox if missing)"
npx wrangler d1 migrations apply bullandbloom --remote 2>&1 | grep -Ev '^\s*$' | tail -n 5

echo "→ uploading secrets to Cloudflare"
printf '%s' "$CID"  | npx wrangler secret put GOOGLE_CLIENT_ID     2>&1 | grep -E "Success|rror" || true
printf '%s' "$CSEC" | npx wrangler secret put GOOGLE_CLIENT_SECRET 2>&1 | grep -E "Success|rror" || true

echo "→ redeploying with SITE_URL=$PREVIEW (preview only; main config still says thebullandbloom.com)"
npx wrangler deploy --var "SITE_URL:$PREVIEW" 2>&1 | grep -E "Uploaded|Deployed|workers.dev|rror" || true

echo "→ checking the deployed Worker"
echo "  health: $(curl -sS "$PREVIEW/api/health")"
echo
echo "Done. Open $PREVIEW/admin/ → Google → Connect Google, signed in as thebullandbloom@gmail.com."
echo "Expect Google's 'unverified app' screen once: Advanced → Go to The Bull and Bloom store (unsafe) → allow both permissions."
```

Then:

```bash
chmod +x scripts/google-setup.sh
scripts/google-setup.sh
```

Migration order matters: the script applies `0002_outbox.sql` before deploying, so a webhook arriving mid-deploy never hits code that expects a table the database lacks.

- [ ] **Step 4: Connect and check D22**

In the preview admin: Google → Connect Google, signed in as thebullandbloom@gmail.com. Expected: consent screen (with the unverified interstitial), then `/admin/?google=connected` and the panel reading "Connected as thebullandbloom@gmail.com". In Google Calendar for that account, two new calendars exist: "Bull and Bloom: Closed" and "Bull and Bloom: Orders".

If Google refuses the consent flow outright (error `access_denied` with a message about verification) rather than showing the interstitial, D22's fallback applies: switch the app back to Testing, add thebullandbloom@gmail.com as a test user, connect, and file for verification. Record whichever path happened in the spec's D22 row.

- [x] **Step 5: Acceptance walk-through (spec §4.6 items for this plan)**

1. **Closed day via calendar.** In Google Calendar, add an all-day event on the Closed calendar for a weekday two weeks out. Admin → Google → "Check the Closed calendar now": the day turns pink in the grid; the storefront picker no longer offers it. Delete the event, check again: the day reopens. Then leave a closed event in place and wait for the cron (up to 15 minutes) to confirm sync runs on its own (the panel's "last checked" time advances).
2. **Admin close still wins alone.** Close a different day from admin: closed with no calendar event. Sync again: it stays closed (calendar sync never touches admin rows).
3. **Order → calendar → emails.** Buy a pickup bouquet with `4242 4242 4242 4242` using Ryan's email as the customer. Expected within seconds: an all-day event on the Orders calendar for that date titled "<Size> · <Name> · pickup" whose description ends with the admin link; a confirmation email at Ryan's address from "The Bull and Bloom <thebullandbloom@gmail.com>"; a "New order:" email in thebullandbloom@gmail.com's inbox. Open the admin link from the phone: the day is selected.
4. **Retry path.** In admin → Google → Disconnect, buy again, confirm the panel later shows "3 message(s) waiting to send" and the order is still `paid`. Reconnect: within 15 minutes (or via "Retry waiting messages" if any show as failed) the event and emails arrive. Note (final review, 2026-09-08): Disconnect also clears every calendar-mirrored closed day, so the day closed in step 1 reopens until the next sync after reconnecting; admin-closed days are untouched.
5. **Plan 1 regression.** Repeat Plan 1 Task 15 Step 5 items 1 and 3 (buy; close today in admin).

- [x] **Step 6: Record and commit**

README, under "Local development", change step 1 to name six secrets and add:

```markdown
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are optional locally; without them the admin Google panel says "not set up".
```

Under "Deploy" add:

```markdown
Google: `scripts/google-setup.sh` uploads the OAuth client secrets, applies migrations, and redeploys to the preview. Anthony connects from admin → Google. The OAuth client's redirect URIs must include `<site>/admin/google/callback` for both the preview and thebullandbloom.com.
```

Spec: add rows D18–D25 to §3 (copy from this plan's decisions table, with the D22 outcome from Step 4); append Plan 2's results to §8; update §9 to say Plan 2 is on the preview and what Anthony would notice (orders on his phone calendar, emails both ways, closing days from his calendar).

```bash
git add scripts/google-setup.sh README.md docs/superpowers/specs/2026-09-07-store-design.md
git commit -m "chore(google): setup script, deploy notes, and spec decisions D18–D25"
```

Then post the staging review call to Ryan (per the MeOS release rule: what is on the preview, what Anthony would notice, what is close behind, recommendation). Plan 3 (Uber Direct) or DNS cutover is next; cutover also needs Anthony's real prices, cap, address, and the live Stripe key (spec §7).

---

## Self-review

**Spec coverage for Plan 2's scope.** §2 item 3 (blackouts from the Closed calendar, union with admin): Tasks 4, 5, 9; the union is Plan 1's `getOverrides`, re-tested in Task 5. §2 item 9 (every confirmed order on the Orders calendar): Tasks 7, 8. §2 item 10 (confirmations from thebullandbloom@gmail.com via Gmail on the same grant): Tasks 3, 7, 8; the "same authorization" is one consent with both scopes (Task 3 `SCOPES`). §4.4 blackout sync every 15 min over 90 days, upsert calendar rows, remove vanished, never touch admin rows, keep last state on failure: Task 5 (`SYNC_DAYS`, `syncCalendarOverrides`, error path) and Task 9 (cron). §4.4 webhook side effects (calendar event, emails to customer and Anthony): Task 8. §4.5 Google Calendar unreachable → last state + admin toggles, events queue and retry: Tasks 5, 6, 8. §4.5 Gmail unreachable → queue and retry, Stripe receipt still reaches the customer: Tasks 6, 8 (Stripe's receipt is Stripe's; unchanged). §5 `adapters/google` (listClosedEvents, createOrderEvent, sendMail, token refresh): Task 3 (`listEvents`, `insertAllDayEvent`, `sendMail`, `accessToken`). §5 `routes/admin` Google connect: Tasks 10, 11. §7 item 3 (Cloud project, APIs, OAuth client, one authorization from admin, two calendars): Task 12 plus D19 automating the calendars. §4.7 secrets in Cloudflare: Task 12 script. Failure-mode row "admin shows held orders older than 30 min in red" is Plan 1 territory and not touched. Not in this plan by design: courier tracking emails (Plan 3 reuses `sendMail` and the outbox), subscriber events (Plan 4), Instagram, DNS.

**Placeholders.** None. Values Anthony must supply (`ownerEmail` default, SAMPLE pickup text) are the same spec §7 blanks Plan 1 named. The client id/secret are gitignored `.dev.vars` entries by design.

**Type consistency.** `Google`, `CalendarEvent`, `NewAllDayEvent`, `Mail`, `Connection` are defined once in Task 1 and used unchanged in Tasks 3, 4, 7, 8, 10. `ConnectionSource` and `GoogleState` come from Task 2 and are consumed by Tasks 3, 8, 10 with the same field names (`closedCalendarId`, `ordersCalendarId`, `account`, `connectedAt`). `BlackoutSyncResult` (Task 5) is the exact JSON Task 10's sync endpoint returns and Task 9 nests. `DrainResult` (Task 8) is nested by Tasks 9 and 10 (`{ retried, drain }`). `OutboxKind`, `ORDER_PAID_KINDS`, `enqueueForSessionStatements`, `dueItems`, `markDone`, `markFailed`, `counts`, `retryFailed`, `backoff` (Task 6) are called with those names in Tasks 8, 10. `markPaidBySession`'s new fourth parameter (Task 8) matches the webhook call. `humanDate`/`longDate` live in `core/time` from Task 7 onward; `routes/public.ts` re-exports `humanDate`. `testApp()` returns `{ app, payments, google, fetch }` and `testServices()` returns `{ services, payments, google }` (Task 1), used that way in Tasks 5, 8, 9, 10. `Order.calendarEventId` is added in Task 7 and used in Task 8. Config additions (`studio.ownerEmail`, `calendars.closed/orders`) are made in Task 5 and read in Tasks 7, 10.
