# Store Plan 1: Core store (capacity, Stripe checkout, admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static thebullandbloom.com page into a working pickup-only store: a three-size menu, a date picker driven by daily capacity, Stripe Checkout, and a passcode admin page where Anthony sets the cap, closes days, and sees orders.

**Architecture:** The existing static site moves into `site/` and is served by one Cloudflare Worker with static assets. The Worker (TypeScript, Hono) exposes `/api/*` for the storefront, `/webhooks/stripe`, and `/admin/api/*`; state lives in D1 (SQLite). Pure capacity logic lives in `src/core/` with no I/O; every external service sits behind an interface with a fake for tests.

**Tech Stack:** Cloudflare Workers + static assets, D1, Hono, TypeScript, Stripe Node SDK (fetch client), Vitest with `@cloudflare/vitest-pool-workers`, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-07-store-design.md`. This plan implements §2 items 1 (minus carousel and subscriptions), 2, 4, 8 (grid, cap, close, orders, done), and the hold flow in §4.4. Plans 2–5 cover Google, Uber, subscriptions, Instagram.

## Global Constraints

- Timezone for all date math: `America/New_York` (spec §4.2). Dates are `YYYY-MM-DD` strings everywhere; never a JS `Date` for a calendar day.
- Money is integer cents everywhere. Never floats.
- Capacity counts one-time orders only (spec D14): `source = 'one_time' AND status IN ('held','paid')`.
- Hold duration 30 minutes (spec §4.2). Stripe Checkout `expires_at` must be 30 min to 24 h after creation; we use exactly 30 min.
- Secrets never in the repo: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_PASSCODE`, `ADMIN_SECRET` come from Wrangler secrets (spec §4.7).
- Core modules (`src/core/*`) import nothing from `src/adapters`, `src/store`, or Hono.
- Every task ends with `npm test` green and a commit on branch `feat/store`.
- Storefront stays plain HTML/CSS/JS with no framework or build step for the site itself (spec §4.1 site/).
- Deviation from spec §4.3, recorded here: holds are a nullable `hold_expires_at` column on `orders`, not a separate `holds` table. D1 has no interactive transactions, and a single conditional `INSERT … SELECT … WHERE count < cap` is atomic only if the hold rides on the same row. Behavior is identical.

---

## File structure

```
wrangler.toml                 Worker config: assets dir, D1 binding, cron triggers, vars
package.json / tsconfig.json / vitest.config.ts
store.config.json             repo config (spec §4.2): sizes, defaults, tz, studio
migrations/0001_init.sql      orders, day_overrides, settings
site/                         static assets (moved from repo root)
  index.html                  existing page + menu + order flow
  thanks.html                 Stripe success return page
  store.js                    storefront order flow (fetches /api/*)
  admin/index.html            admin page (fetches /admin/api/*)
  assets/                     existing images
src/
  index.ts                    Hono app assembly, fetch + scheduled exports
  env.ts                      Env bindings type
  config.ts                   typed loader for store.config.json
  core/time.ts                tz-aware YMD/HM helpers, weekday, addDays
  core/capacity.ts            capFor, remaining, isOrderable, availabilityFor
  store/settings.ts           settings table ↔ Defaults
  store/orders.ts             order queries incl. atomic held insert, expiry
  store/overrides.ts          day_overrides queries
  adapters/payments.ts        Payments interface + FakePayments
  adapters/stripe.ts          StripePayments (real)
  routes/public.ts            /api/config /api/availability /api/checkout
  routes/webhooks.ts          /webhooks/stripe
  routes/admin.ts             /admin/api/* + session cookie auth
  admin/session.ts            HMAC cookie make/verify
  scheduled.ts                cron: expire holds
tests/
  setup.ts                    apply D1 migrations
  core/time.test.ts core/capacity.test.ts
  store/orders.test.ts store/overrides.test.ts store/settings.test.ts
  admin/session.test.ts
  routes/public.test.ts routes/webhooks.test.ts routes/admin.test.ts
  helpers.ts                  build app with fakes, seed helpers
```

---

### Task 1: Project scaffold and static assets under a Worker

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `src/index.ts`, `src/env.ts`, `tests/setup.ts`, `tests/smoke.test.ts`, `.gitignore`
- Move: `index.html` → `site/index.html`, `assets/` → `site/assets/`
- Modify: `README.md`

**Interfaces:**
- Produces: `Env` type in `src/env.ts` with `DB: D1Database`, `ASSETS: Fetcher`, `SITE_URL: string`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_PASSCODE`, `ADMIN_SECRET` (all `string`). `src/index.ts` exports `default { fetch, scheduled }` and a named `app` (Hono).

- [ ] **Step 1: Init npm project and install**

```bash
cd ~/Dev\ Projects/thebullandbloom
npm init -y >/dev/null
npm pkg set name="thebullandbloom" private=true type="module" \
  scripts.test="vitest run" scripts.dev="wrangler dev" scripts.deploy="wrangler deploy" \
  scripts.typecheck="tsc --noEmit"
npm i hono stripe
npm i -D wrangler typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

- [ ] **Step 2: Move the site into `site/`**

```bash
git mv index.html site/index.html
git mv assets site/assets
printf 'node_modules/\n.wrangler/\n.dev.vars\n' > .gitignore
```

- [ ] **Step 3: Write `wrangler.toml`**

```toml
name = "thebullandbloom"
main = "src/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./site"
binding = "ASSETS"
html_handling = "auto-trailing-slash"
not_found_handling = "404-page"

[[d1_databases]]
binding = "DB"
database_name = "bullandbloom"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[triggers]
crons = ["*/15 * * * *"]

[vars]
SITE_URL = "https://thebullandbloom.com"
```

The `database_id` is a placeholder until Task 15 runs `wrangler d1 create` (local dev and tests do not need a real id).

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types/2023-07-01", "@cloudflare/vitest-pool-workers"],
    "lib": ["ES2022"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 5: Write `vitest.config.ts` and `tests/setup.ts`**

```ts
// vitest.config.ts
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./tests/setup.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              STRIPE_SECRET_KEY: "sk_test_fake",
              STRIPE_WEBHOOK_SECRET: "whsec_fake",
              ADMIN_PASSCODE: "open-sesame-1234",
              ADMIN_SECRET: "test-secret",
            },
          },
        },
      },
    },
  };
});
```

```ts
// tests/setup.ts
import { applyD1Migrations, env } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ASSETS: Fetcher;
    SITE_URL: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
    ADMIN_PASSCODE: string;
    ADMIN_SECRET: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

Create an empty `migrations/` directory with a `.gitkeep` so `readD1Migrations` succeeds before Task 5 adds the first migration.

- [ ] **Step 6: Write `src/env.ts` and a minimal `src/index.ts`**

```ts
// src/env.ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SITE_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_PASSCODE: string;
  ADMIN_SECRET: string;
}
```

```ts
// src/index.ts
import { Hono } from "hono";
import type { Env } from "./env";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {},
};
```

- [ ] **Step 7: Write the failing smoke test**

```ts
// tests/smoke.test.ts
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("worker", () => {
  it("answers /api/health", async () => {
    const r = await SELF.fetch("https://example.com/api/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
  it("serves the static home page", async () => {
    const r = await SELF.fetch("https://example.com/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("The Bull and Bloom");
  });
});
```

- [ ] **Step 8: Run tests, expect pass**

Run: `npm test`
Expected: 2 passed. If the static asset test fails with 404, confirm `site/index.html` exists and `[assets] directory` is `./site`.

- [ ] **Step 9: Update README and commit**

Replace README body with:

```markdown
# The Bull and Bloom

thebullandbloom.com — floral design by Anthony Demonia. Static site plus a Cloudflare Worker store.

- `site/` — the pages and images (no build step).
- `src/` — the Worker: `/api/*` for the storefront, `/webhooks/stripe`, `/admin/api/*`.
- `migrations/` — D1 schema.
- `store.config.json` — menu, prices, capacity defaults.
- Design: `docs/superpowers/specs/2026-09-07-store-design.md`.

`npm test` runs everything in a local workerd with a throwaway D1. `npm run dev` serves locally.
```

```bash
git add -A
git commit -m "chore(store): worker scaffold, site moved under site/, vitest workers pool"
```

---

### Task 2: Repo config loader

**Files:**
- Create: `store.config.json`, `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Size { id: string; name: string; description: string; priceCents: number }
  export interface StoreConfig {
    timezone: string;                       // "America/New_York"
    studio: { pickupAddress: string; pickupInstructions: string };
    sizes: Size[];
    defaults: { cap: number; cutoff: string; openWeekdays: number[] }; // cutoff "HH:MM", weekdays 0=Sun
    holdMinutes: number;
  }
  export function loadConfig(): StoreConfig   // validated, throws on bad shape
  export function sizeById(cfg: StoreConfig, id: string): Size | undefined
  ```

- [ ] **Step 1: Write `store.config.json`**

Values marked SAMPLE are replaced by Anthony's numbers before launch (spec §7).

```json
{
  "timezone": "America/New_York",
  "studio": {
    "pickupAddress": "SAMPLE — studio address, Upstate NY",
    "pickupInstructions": "SAMPLE — text Anthony at (518) 334-0517 when you arrive."
  },
  "sizes": [
    { "id": "posy", "name": "Posy", "description": "A small hand-tied bunch. SAMPLE.", "priceCents": 5500 },
    { "id": "bouquet", "name": "Bouquet", "description": "The classic 10–12 stem bouquet. SAMPLE.", "priceCents": 8500 },
    { "id": "statement", "name": "Statement", "description": "A generous, showpiece bouquet. SAMPLE.", "priceCents": 13500 }
  ],
  "defaults": { "cap": 4, "cutoff": "11:00", "openWeekdays": [2, 3, 4, 5, 6] },
  "holdMinutes": 30
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig, sizeById, validateConfig } from "../src/config";

describe("config", () => {
  it("loads the repo config", () => {
    const cfg = loadConfig();
    expect(cfg.timezone).toBe("America/New_York");
    expect(cfg.sizes.length).toBeGreaterThan(0);
    expect(sizeById(cfg, cfg.sizes[0].id)?.id).toBe(cfg.sizes[0].id);
    expect(sizeById(cfg, "nope")).toBeUndefined();
  });
  it("rejects bad cutoff", () => {
    const cfg = { ...loadConfig(), defaults: { cap: 1, cutoff: "25:00", openWeekdays: [1] } };
    expect(() => validateConfig(cfg)).toThrow(/cutoff/);
  });
  it("rejects duplicate size ids and non-integer cents", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, sizes: [base.sizes[0], base.sizes[0]] })).toThrow(/duplicate/);
    expect(() => validateConfig({ ...base, sizes: [{ ...base.sizes[0], priceCents: 1.5 }] })).toThrow(/priceCents/);
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL, cannot find module `../src/config`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import raw from "../store.config.json";

export interface Size { id: string; name: string; description: string; priceCents: number }
export interface StoreConfig {
  timezone: string;
  studio: { pickupAddress: string; pickupInstructions: string };
  sizes: Size[];
  defaults: { cap: number; cutoff: string; openWeekdays: number[] };
  holdMinutes: number;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateConfig(cfg: StoreConfig): StoreConfig {
  if (!cfg.timezone) throw new Error("config: timezone required");
  if (!HM.test(cfg.defaults.cutoff)) throw new Error("config: defaults.cutoff must be HH:MM");
  if (!Number.isInteger(cfg.defaults.cap) || cfg.defaults.cap < 0) throw new Error("config: defaults.cap must be a non-negative integer");
  if (!cfg.defaults.openWeekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error("config: openWeekdays must be 0..6");
  if (!Number.isInteger(cfg.holdMinutes) || cfg.holdMinutes < 30) throw new Error("config: holdMinutes must be an integer >= 30 (Stripe minimum)");
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

- [ ] **Step 5: Run, expect pass, commit**

Run: `npx vitest run tests/config.test.ts` → 3 passed.

```bash
git add store.config.json src/config.ts tests/config.test.ts
git commit -m "feat(store): repo config with validation"
```

---

### Task 3: Time helpers (timezone-safe dates)

**Files:**
- Create: `src/core/time.ts`, `tests/core/time.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function ymdIn(tz: string, at: Date): string          // "YYYY-MM-DD" in tz
  export function hmIn(tz: string, at: Date): string           // "HH:MM" 24h in tz
  export function weekdayOf(ymd: string): number               // 0=Sun..6=Sat
  export function addDays(ymd: string, n: number): string
  export function isYmd(s: unknown): s is string
  export function ymdRange(from: string, to: string): string[] // inclusive
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/time.test.ts
import { describe, it, expect } from "vitest";
import { ymdIn, hmIn, weekdayOf, addDays, isYmd, ymdRange } from "../../src/core/time";

const NY = "America/New_York";

describe("time", () => {
  it("renders date and time in the studio timezone", () => {
    // 2026-09-08T03:30Z is 2026-09-07 23:30 in New York (EDT, UTC-4)
    const at = new Date("2026-09-08T03:30:00Z");
    expect(ymdIn(NY, at)).toBe("2026-09-07");
    expect(hmIn(NY, at)).toBe("23:30");
  });
  it("renders midnight as 00:00 not 24:00", () => {
    const at = new Date("2026-09-08T04:00:00Z"); // 00:00 EDT
    expect(hmIn(NY, at)).toBe("00:00");
  });
  it("computes weekday without timezone drift", () => {
    expect(weekdayOf("2026-09-07")).toBe(1); // Monday
    expect(weekdayOf("2026-09-13")).toBe(0); // Sunday
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("validates YMD strings strictly", () => {
    expect(isYmd("2026-09-07")).toBe(true);
    expect(isYmd("2026-9-7")).toBe(false);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd(42)).toBe(false);
  });
  it("builds inclusive ranges", () => {
    expect(ymdRange("2026-09-07", "2026-09-09")).toEqual(["2026-09-07", "2026-09-08", "2026-09-09"]);
    expect(ymdRange("2026-09-09", "2026-09-07")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure** — `npx vitest run tests/core/time.test.ts` → cannot find module.

- [ ] **Step 3: Implement `src/core/time.ts`**

```ts
export function ymdIn(tz: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function hmIn(tz: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("hour")}:${get("minute")}`;
}

function toUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(ymd: string): number {
  return toUtc(ymd).getUTCDay();
}

export function addDays(ymd: string, n: number): string {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromUtc(toUtc(s)) === s; // rejects 2026-02-30 (rolls to March)
}

export function ymdRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
```

- [ ] **Step 4: Run, expect pass, commit**

```bash
git add src/core/time.ts tests/core/time.test.ts
git commit -m "feat(store): timezone-safe date helpers"
```

---

### Task 4: Capacity core

**Files:**
- Create: `src/core/capacity.ts`, `tests/core/capacity.test.ts`

**Interfaces:**
- Consumes: `ymdIn`, `hmIn`, `weekdayOf` from Task 3.
- Produces:
  ```ts
  export interface Defaults { cap: number; cutoff: string; openWeekdays: number[] }
  export interface Override { cap: number | null; closed: boolean }
  export interface Clock { now: Date; tz: string }
  export interface Availability { date: string; open: boolean; cap: number; used: number; remaining: number; orderable: boolean }
  export function capFor(date: string, defaults: Defaults, override?: Override | null): number
  export function isOrderable(date: string, remaining: number, defaults: Defaults, clock: Clock): boolean
  export function availabilityFor(date: string, defaults: Defaults, override: Override | null, used: number, clock: Clock): Availability
  ```

Rules (spec §2.2, §4.3, D3, D14):
- Closed override → cap 0.
- Weekday not in `openWeekdays` and no override cap → 0. An override cap on a normally-closed weekday opens that day (Anthony taking a Sunday).
- `remaining = max(0, cap − used)`.
- Orderable iff date ≥ today (studio tz), remaining > 0, and if date is today then now < cutoff.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/capacity.test.ts
import { describe, it, expect } from "vitest";
import { capFor, isOrderable, availabilityFor, type Defaults } from "../../src/core/capacity";

const NY = "America/New_York";
const defaults: Defaults = { cap: 4, cutoff: "11:00", openWeekdays: [2, 3, 4, 5, 6] }; // Tue–Sat
const tue = "2026-09-08", sun = "2026-09-13";
// 2026-09-08 10:00 EDT == 14:00Z ; 12:00 EDT == 16:00Z
const clockBeforeCutoff = { now: new Date("2026-09-08T14:00:00Z"), tz: NY };
const clockAfterCutoff = { now: new Date("2026-09-08T16:00:00Z"), tz: NY };

describe("capFor", () => {
  it("uses the default cap on an open weekday", () => expect(capFor(tue, defaults)).toBe(4));
  it("is zero on a non-open weekday", () => expect(capFor(sun, defaults)).toBe(0));
  it("is zero when closed, even with a cap override", () =>
    expect(capFor(tue, defaults, { cap: 9, closed: true })).toBe(0));
  it("uses the override cap", () => expect(capFor(tue, defaults, { cap: 2, closed: false })).toBe(2));
  it("an override cap opens a normally-closed weekday", () =>
    expect(capFor(sun, defaults, { cap: 3, closed: false })).toBe(3));
  it("a null override cap falls back to the default", () =>
    expect(capFor(tue, defaults, { cap: null, closed: false })).toBe(4));
});

describe("isOrderable", () => {
  it("past dates are never orderable", () =>
    expect(isOrderable("2026-09-07", 4, defaults, clockBeforeCutoff)).toBe(false));
  it("today is orderable before the cutoff with room", () =>
    expect(isOrderable(tue, 1, defaults, clockBeforeCutoff)).toBe(true));
  it("today is not orderable at or after the cutoff", () =>
    expect(isOrderable(tue, 1, defaults, clockAfterCutoff)).toBe(false));
  it("a future date is orderable after today's cutoff", () =>
    expect(isOrderable("2026-09-09", 1, defaults, clockAfterCutoff)).toBe(true));
  it("zero remaining is never orderable", () =>
    expect(isOrderable("2026-09-09", 0, defaults, clockBeforeCutoff)).toBe(false));
  it("the cutoff minute itself counts as closed", () => {
    const atCutoff = { now: new Date("2026-09-08T15:00:00Z"), tz: NY }; // 11:00 EDT
    expect(isOrderable(tue, 1, defaults, atCutoff)).toBe(false);
  });
});

describe("availabilityFor", () => {
  it("assembles the public shape", () => {
    expect(availabilityFor(tue, defaults, null, 3, clockBeforeCutoff)).toEqual({
      date: tue, open: true, cap: 4, used: 3, remaining: 1, orderable: true,
    });
  });
  it("remaining never goes negative", () => {
    const a = availabilityFor(tue, defaults, { cap: 2, closed: false }, 5, clockBeforeCutoff);
    expect(a.remaining).toBe(0);
    expect(a.orderable).toBe(false);
  });
  it("closed day reports open=false", () => {
    expect(availabilityFor(tue, defaults, { cap: null, closed: true }, 0, clockBeforeCutoff).open).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure** — module not found.

- [ ] **Step 3: Implement `src/core/capacity.ts`**

```ts
import { hmIn, weekdayOf, ymdIn } from "./time";

export interface Defaults { cap: number; cutoff: string; openWeekdays: number[] }
export interface Override { cap: number | null; closed: boolean }
export interface Clock { now: Date; tz: string }
export interface Availability {
  date: string; open: boolean; cap: number; used: number; remaining: number; orderable: boolean;
}

export function capFor(date: string, defaults: Defaults, override?: Override | null): number {
  if (override?.closed) return 0;
  if (override && override.cap !== null) return override.cap;
  return defaults.openWeekdays.includes(weekdayOf(date)) ? defaults.cap : 0;
}

export function remaining(cap: number, used: number): number {
  return Math.max(0, cap - used);
}

export function isOrderable(date: string, left: number, defaults: Defaults, clock: Clock): boolean {
  const today = ymdIn(clock.tz, clock.now);
  if (date < today) return false;
  if (left <= 0) return false;
  if (date === today && hmIn(clock.tz, clock.now) >= defaults.cutoff) return false;
  return true;
}

export function availabilityFor(
  date: string, defaults: Defaults, override: Override | null, used: number, clock: Clock,
): Availability {
  const cap = capFor(date, defaults, override);
  const left = remaining(cap, used);
  return { date, open: cap > 0, cap, used, remaining: left, orderable: isOrderable(date, left, defaults, clock) };
}
```

- [ ] **Step 4: Run, expect pass, commit**

```bash
git add src/core/capacity.ts tests/core/capacity.test.ts
git commit -m "feat(store): capacity core — cap, remaining, orderable"
```

---

### Task 5: D1 schema and the store modules

**Files:**
- Create: `migrations/0001_init.sql`, `src/store/settings.ts`, `src/store/overrides.ts`, `src/store/orders.ts`, `tests/store/settings.test.ts`, `tests/store/overrides.test.ts`, `tests/store/orders.test.ts`
- Delete: `migrations/.gitkeep`

**Interfaces:**
- Consumes: `Defaults`, `Override` from Task 4.
- Produces:
  ```ts
  // settings.ts
  export async function loadDefaults(db: D1Database, base: Defaults): Promise<Defaults>   // base overlaid by settings rows
  export async function saveDefaults(db: D1Database, patch: Partial<Defaults>): Promise<void>
  // overrides.ts
  export type OverrideSource = "admin" | "calendar";
  export interface DayOverride extends Override { date: string; source: OverrideSource }
  export async function getOverrides(db, from: string, to: string): Promise<Map<string, Override>>   // merged: closed if any source closed; cap from admin row if set
  export async function putAdminOverride(db, date: string, o: Override): Promise<void>
  export async function clearAdminOverride(db, date: string): Promise<void>
  // orders.ts
  export type OrderStatus = "held" | "paid" | "done" | "cancelled" | "refunded";
  export interface Order { id; createdAt: number; status: OrderStatus; date; sizeId; fulfillment: "pickup" | "delivery";
    customerName; customerEmail; customerPhone: string | null; addressJson: string | null; note: string | null;
    stripeSessionId: string | null; stripePaymentIntent: string | null; bouquetCents: number; deliveryCents: number;
    source: "one_time" | "subscription"; holdExpiresAt: number | null }
  export interface NewOrder { id; date; sizeId; fulfillment; customerName; customerEmail; customerPhone; note; bouquetCents; deliveryCents }
  export async function countUsed(db, from, to): Promise<Map<string, number>>
  export async function tryInsertHeldOrder(db, o: NewOrder, cap: number, now: number, holdExpiresAt: number): Promise<boolean>
  export async function attachSession(db, orderId, sessionId): Promise<void>
  export async function getOrder(db, id): Promise<Order | null>
  export async function markPaidBySession(db, sessionId, paymentIntent): Promise<Order | null>   // only held → paid; returns null if not found or not held
  export async function cancelHeldBySession(db, sessionId): Promise<boolean>
  export async function cancelOrder(db, id): Promise<boolean>
  export async function expireHolds(db, now: number): Promise<number>   // held & hold_expires_at <= now → cancelled
  export async function listOrders(db, date): Promise<Order[]>
  export async function setStatus(db, id, status: OrderStatus): Promise<boolean>
  ```
  All timestamps are Unix seconds (integers).

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0001_init.sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','paid','done','cancelled','refunded')),
  date TEXT NOT NULL,
  size_id TEXT NOT NULL,
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  address_json TEXT,
  note TEXT,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  bouquet_cents INTEGER NOT NULL,
  delivery_cents INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'one_time' CHECK (source IN ('one_time','subscription')),
  subscriber_id TEXT,
  calendar_event_id TEXT,
  hold_expires_at INTEGER
);
CREATE INDEX orders_date_status ON orders (date, source, status);
CREATE INDEX orders_hold ON orders (status, hold_expires_at);

CREATE TABLE day_overrides (
  date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin','calendar')),
  cap INTEGER,
  closed INTEGER NOT NULL DEFAULT 0,
  calendar_event_id TEXT,
  PRIMARY KEY (date, source)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/store/settings.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { loadDefaults, saveDefaults } from "../../src/store/settings";

const base = { cap: 4, cutoff: "11:00", openWeekdays: [2, 3, 4, 5, 6] };

describe("settings", () => {
  it("returns base defaults when nothing is saved", async () => {
    expect(await loadDefaults(env.DB, base)).toEqual(base);
  });
  it("overlays saved values and keeps the rest", async () => {
    await saveDefaults(env.DB, { cap: 6, openWeekdays: [1, 2] });
    expect(await loadDefaults(env.DB, base)).toEqual({ cap: 6, cutoff: "11:00", openWeekdays: [1, 2] });
    await saveDefaults(env.DB, { cutoff: "10:30" });
    expect((await loadDefaults(env.DB, base)).cutoff).toBe("10:30");
  });
});
```

```ts
// tests/store/overrides.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getOverrides, putAdminOverride, clearAdminOverride } from "../../src/store/overrides";

describe("overrides", () => {
  it("round-trips an admin override", async () => {
    await putAdminOverride(env.DB, "2026-09-10", { cap: 2, closed: false });
    const m = await getOverrides(env.DB, "2026-09-01", "2026-09-30");
    expect(m.get("2026-09-10")).toEqual({ cap: 2, closed: false });
  });
  it("replaces on second put and clears", async () => {
    await putAdminOverride(env.DB, "2026-09-11", { cap: null, closed: true });
    await putAdminOverride(env.DB, "2026-09-11", { cap: 5, closed: false });
    expect((await getOverrides(env.DB, "2026-09-11", "2026-09-11")).get("2026-09-11")).toEqual({ cap: 5, closed: false });
    await clearAdminOverride(env.DB, "2026-09-11");
    expect((await getOverrides(env.DB, "2026-09-11", "2026-09-11")).has("2026-09-11")).toBe(false);
  });
  it("merges sources: closed wins from either, cap from admin", async () => {
    await env.DB.prepare("INSERT INTO day_overrides (date, source, cap, closed) VALUES ('2026-09-12','calendar',NULL,1)").run();
    await putAdminOverride(env.DB, "2026-09-12", { cap: 3, closed: false });
    expect((await getOverrides(env.DB, "2026-09-12", "2026-09-12")).get("2026-09-12")).toEqual({ cap: 3, closed: true });
  });
  it("respects the date range", async () => {
    await putAdminOverride(env.DB, "2026-10-01", { cap: 1, closed: false });
    expect((await getOverrides(env.DB, "2026-09-01", "2026-09-30")).has("2026-10-01")).toBe(false);
  });
});
```

```ts
// tests/store/orders.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  tryInsertHeldOrder, countUsed, attachSession, getOrder, markPaidBySession,
  cancelHeldBySession, expireHolds, listOrders, setStatus, type NewOrder,
} from "../../src/store/orders";

let n = 0;
function fresh(date = "2026-09-10"): NewOrder {
  n += 1;
  return {
    id: `o${n}`, date, sizeId: "bouquet", fulfillment: "pickup",
    customerName: "Pat", customerEmail: "pat@example.com", customerPhone: null, note: null,
    bouquetCents: 8500, deliveryCents: 0,
  };
}
const NOW = 1_800_000_000;

describe("orders", () => {
  it("inserts while under cap, refuses at cap", async () => {
    expect(await tryInsertHeldOrder(env.DB, fresh("2026-09-20"), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldOrder(env.DB, fresh("2026-09-20"), 2, NOW, NOW + 1800)).toBe(true);
    expect(await tryInsertHeldOrder(env.DB, fresh("2026-09-20"), 2, NOW, NOW + 1800)).toBe(false);
    expect((await countUsed(env.DB, "2026-09-20", "2026-09-20")).get("2026-09-20")).toBe(2);
  });
  it("cancelled orders do not count; subscription orders do not count", async () => {
    const a = fresh("2026-09-21");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await setStatus(env.DB, a.id, "cancelled");
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, source)
       VALUES ('sub1', ?, 'paid', '2026-09-21', 'bouquet', 'pickup', 'S', 's@example.com', 8500, 'subscription')`,
    ).bind(NOW).run();
    expect((await countUsed(env.DB, "2026-09-21", "2026-09-21")).get("2026-09-21") ?? 0).toBe(0);
  });
  it("attaches a session, marks paid once, ignores a second completion", async () => {
    const a = fresh("2026-09-22");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_1");
    const paid = await markPaidBySession(env.DB, "cs_1", "pi_1");
    expect(paid?.status).toBe("paid");
    expect(paid?.holdExpiresAt).toBeNull();
    expect(await markPaidBySession(env.DB, "cs_1", "pi_1")).toBeNull();
    expect((await getOrder(env.DB, a.id))?.stripePaymentIntent).toBe("pi_1");
  });
  it("cancels a held order by session but never a paid one", async () => {
    const a = fresh("2026-09-23");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await attachSession(env.DB, a.id, "cs_2");
    await markPaidBySession(env.DB, "cs_2", "pi_2");
    expect(await cancelHeldBySession(env.DB, "cs_2")).toBe(false);
    const b = fresh("2026-09-23");
    await tryInsertHeldOrder(env.DB, b, 5, NOW, NOW + 1800);
    await attachSession(env.DB, b.id, "cs_3");
    expect(await cancelHeldBySession(env.DB, "cs_3")).toBe(true);
    expect((await getOrder(env.DB, b.id))?.status).toBe("cancelled");
  });
  it("expires holds past their deadline only", async () => {
    const a = fresh("2026-09-24"), b = fresh("2026-09-24");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 100);
    await tryInsertHeldOrder(env.DB, b, 5, NOW, NOW + 5000);
    expect(await expireHolds(env.DB, NOW + 200)).toBe(1);
    expect((await getOrder(env.DB, a.id))?.status).toBe("cancelled");
    expect((await getOrder(env.DB, b.id))?.status).toBe("held");
  });
  it("lists a day's orders oldest first", async () => {
    const a = fresh("2026-09-25"), b = fresh("2026-09-25");
    await tryInsertHeldOrder(env.DB, a, 5, NOW, NOW + 1800);
    await tryInsertHeldOrder(env.DB, b, 5, NOW + 1, NOW + 1800);
    expect((await listOrders(env.DB, "2026-09-25")).map((o) => o.id)).toEqual([a.id, b.id]);
  });
});
```

- [ ] **Step 3: Run, expect failure** — `npm test` → modules not found (the migration itself applies fine).

- [ ] **Step 4: Implement `src/store/settings.ts`**

```ts
import type { Defaults } from "../core/capacity";

const KEYS = ["cap", "cutoff", "openWeekdays"] as const;

export async function loadDefaults(db: D1Database, base: Defaults): Promise<Defaults> {
  const rows = await db.prepare("SELECT key, value_json FROM settings").all<{ key: string; value_json: string }>();
  const out: Defaults = { ...base, openWeekdays: [...base.openWeekdays] };
  for (const r of rows.results) {
    if ((KEYS as readonly string[]).includes(r.key)) (out as any)[r.key] = JSON.parse(r.value_json);
  }
  return out;
}

export async function saveDefaults(db: D1Database, patch: Partial<Defaults>): Promise<void> {
  const stmts = KEYS.filter((k) => patch[k] !== undefined).map((k) =>
    db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .bind(k, JSON.stringify(patch[k])),
  );
  if (stmts.length) await db.batch(stmts);
}
```

- [ ] **Step 5: Implement `src/store/overrides.ts`**

```ts
import type { Override } from "../core/capacity";

export type OverrideSource = "admin" | "calendar";
interface Row { date: string; source: OverrideSource; cap: number | null; closed: number }

export async function getOverrides(db: D1Database, from: string, to: string): Promise<Map<string, Override>> {
  const rows = await db.prepare("SELECT date, source, cap, closed FROM day_overrides WHERE date BETWEEN ? AND ? ORDER BY date")
    .bind(from, to).all<Row>();
  const out = new Map<string, Override>();
  for (const r of rows.results) {
    const cur = out.get(r.date) ?? { cap: null, closed: false };
    if (r.closed) cur.closed = true;
    if (r.source === "admin" && r.cap !== null) cur.cap = r.cap;
    out.set(r.date, cur);
  }
  return out;
}

export async function putAdminOverride(db: D1Database, date: string, o: Override): Promise<void> {
  await db.prepare(
    `INSERT INTO day_overrides (date, source, cap, closed) VALUES (?, 'admin', ?, ?)
     ON CONFLICT(date, source) DO UPDATE SET cap = excluded.cap, closed = excluded.closed`,
  ).bind(date, o.cap, o.closed ? 1 : 0).run();
}

export async function clearAdminOverride(db: D1Database, date: string): Promise<void> {
  await db.prepare("DELETE FROM day_overrides WHERE date = ? AND source = 'admin'").bind(date).run();
}
```

- [ ] **Step 6: Implement `src/store/orders.ts`**

```ts
export type OrderStatus = "held" | "paid" | "done" | "cancelled" | "refunded";
export type Fulfillment = "pickup" | "delivery";

export interface Order {
  id: string; createdAt: number; status: OrderStatus; date: string; sizeId: string; fulfillment: Fulfillment;
  customerName: string; customerEmail: string; customerPhone: string | null; addressJson: string | null; note: string | null;
  stripeSessionId: string | null; stripePaymentIntent: string | null; bouquetCents: number; deliveryCents: number;
  source: "one_time" | "subscription"; holdExpiresAt: number | null;
}
export interface NewOrder {
  id: string; date: string; sizeId: string; fulfillment: Fulfillment; customerName: string; customerEmail: string;
  customerPhone: string | null; note: string | null; bouquetCents: number; deliveryCents: number;
}

interface Row {
  id: string; created_at: number; status: OrderStatus; date: string; size_id: string; fulfillment: Fulfillment;
  customer_name: string; customer_email: string; customer_phone: string | null; address_json: string | null; note: string | null;
  stripe_session_id: string | null; stripe_payment_intent: string | null; bouquet_cents: number; delivery_cents: number;
  source: "one_time" | "subscription"; hold_expires_at: number | null;
}
const COLS = `id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, customer_phone,
  address_json, note, stripe_session_id, stripe_payment_intent, bouquet_cents, delivery_cents, source, hold_expires_at`;

function fromRow(r: Row): Order {
  return {
    id: r.id, createdAt: r.created_at, status: r.status, date: r.date, sizeId: r.size_id, fulfillment: r.fulfillment,
    customerName: r.customer_name, customerEmail: r.customer_email, customerPhone: r.customer_phone,
    addressJson: r.address_json, note: r.note, stripeSessionId: r.stripe_session_id,
    stripePaymentIntent: r.stripe_payment_intent, bouquetCents: r.bouquet_cents, deliveryCents: r.delivery_cents,
    source: r.source, holdExpiresAt: r.hold_expires_at,
  };
}

const USED = `SELECT COUNT(*) FROM orders WHERE date = ?1 AND source = 'one_time' AND status IN ('held','paid')`;

export async function countUsed(db: D1Database, from: string, to: string): Promise<Map<string, number>> {
  const rows = await db.prepare(
    `SELECT date, COUNT(*) AS n FROM orders WHERE date BETWEEN ? AND ? AND source = 'one_time' AND status IN ('held','paid') GROUP BY date`,
  ).bind(from, to).all<{ date: string; n: number }>();
  return new Map(rows.results.map((r) => [r.date, r.n]));
}

export async function tryInsertHeldOrder(
  db: D1Database, o: NewOrder, cap: number, now: number, holdExpiresAt: number,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, note, bouquet_cents, delivery_cents, source, hold_expires_at)
     SELECT ?2, ?3, 'held', ?1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'one_time', ?12
     WHERE (${USED}) < ?13`,
  ).bind(o.date, o.id, now, o.sizeId, o.fulfillment, o.customerName, o.customerEmail, o.customerPhone, o.note,
    o.bouquetCents, o.deliveryCents, holdExpiresAt, cap).run();
  return res.meta.changes === 1;
}

export async function attachSession(db: D1Database, orderId: string, sessionId: string): Promise<void> {
  await db.prepare("UPDATE orders SET stripe_session_id = ? WHERE id = ?").bind(sessionId, orderId).run();
}

export async function getOrder(db: D1Database, id: string): Promise<Order | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM orders WHERE id = ?`).bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

export async function markPaidBySession(db: D1Database, sessionId: string, paymentIntent: string): Promise<Order | null> {
  const res = await db.prepare(
    `UPDATE orders SET status = 'paid', stripe_payment_intent = ?, hold_expires_at = NULL
     WHERE stripe_session_id = ? AND status = 'held'`,
  ).bind(paymentIntent, sessionId).run();
  if (res.meta.changes !== 1) return null;
  const r = await db.prepare(`SELECT ${COLS} FROM orders WHERE stripe_session_id = ?`).bind(sessionId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function cancelHeldBySession(db: D1Database, sessionId: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE orders SET status = 'cancelled', hold_expires_at = NULL WHERE stripe_session_id = ? AND status = 'held'",
  ).bind(sessionId).run();
  return res.meta.changes === 1;
}

export async function cancelOrder(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE orders SET status = 'cancelled', hold_expires_at = NULL WHERE id = ? AND status = 'held'",
  ).bind(id).run();
  return res.meta.changes === 1;
}

export async function expireHolds(db: D1Database, now: number): Promise<number> {
  const res = await db.prepare(
    "UPDATE orders SET status = 'cancelled', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at <= ?",
  ).bind(now).run();
  return res.meta.changes;
}

export async function listOrders(db: D1Database, date: string): Promise<Order[]> {
  const rows = await db.prepare(`SELECT ${COLS} FROM orders WHERE date = ? ORDER BY created_at, id`).bind(date).all<Row>();
  return rows.results.map(fromRow);
}

export async function setStatus(db: D1Database, id: string, status: OrderStatus): Promise<boolean> {
  const res = await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, id).run();
  return res.meta.changes === 1;
}
```

- [ ] **Step 7: Run, expect pass, commit**

Run: `npm test` → all green. Then:

```bash
git rm -q migrations/.gitkeep
git add migrations src/store tests/store
git commit -m "feat(store): D1 schema, settings/overrides/orders store modules"
```

---

### Task 6: Availability and config endpoints

**Files:**
- Create: `src/routes/public.ts`, `src/app.ts`, `tests/helpers.ts`, `tests/routes/public.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  ```ts
  // src/app.ts
  export interface Services { payments: Payments; clock: () => Date; config: StoreConfig }   // Payments defined in Task 7; for this task declare the interface stub in adapters/payments.ts with only a type
  export function buildApp(services: Services): Hono<{ Bindings: Env }>
  ```
  Routes:
  - `GET /api/config` → `{ timezone, sizes: Size[], studio: { pickupInstructions } }` (no address; pickup address goes in the confirmation, Plan 2)
  - `GET /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ days: Availability[] }`, max 62 days, 400 on bad input.

To keep Task 6 self-contained, create `src/adapters/payments.ts` now with just the interface; Task 7 adds the fake and real implementations.

- [ ] **Step 1: Create the Payments interface stub**

```ts
// src/adapters/payments.ts
export interface CheckoutLineItem { name: string; amountCents: number; quantity: number }
export interface CheckoutInput {
  orderId: string; customerEmail: string; lineItems: CheckoutLineItem[];
  successUrl: string; cancelUrl: string; expiresAt: number; // unix seconds
}
export interface CheckoutSession { id: string; url: string }
export type WebhookEvent =
  | { type: "checkout.session.completed"; sessionId: string; paymentIntent: string }
  | { type: "checkout.session.expired"; sessionId: string }
  | { type: "other" };
export interface Payments {
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  parseWebhook(rawBody: string, signature: string): Promise<WebhookEvent>; // throws on bad signature
}
```

- [ ] **Step 2: Write `tests/helpers.ts`**

```ts
import { env } from "cloudflare:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Payments, WebhookEvent } from "../src/adapters/payments";

export class RecordingPayments implements Payments {
  created: Array<Parameters<Payments["createCheckout"]>[0]> = [];
  failNext = false;
  nextEvent: WebhookEvent = { type: "other" };
  async createCheckout(input: Parameters<Payments["createCheckout"]>[0]) {
    if (this.failNext) { this.failNext = false; throw new Error("stripe down"); }
    this.created.push(input);
    return { id: `cs_${this.created.length}`, url: `https://checkout.example/${this.created.length}` };
  }
  async parseWebhook(_raw: string, signature: string) {
    if (signature !== "good") throw new Error("bad signature");
    return this.nextEvent;
  }
}

export function testApp(now = new Date("2026-09-08T14:00:00Z")) {
  const payments = new RecordingPayments();
  const app = buildApp({ payments, clock: () => now, config: loadConfig() });
  const fetch = (path: string, init?: RequestInit) =>
    app.request(new Request(`https://example.com${path}`, init), undefined, env);
  return { app, payments, fetch };
}

export async function seedAdminOverride(date: string, cap: number | null, closed: boolean) {
  await env.DB.prepare("INSERT OR REPLACE INTO day_overrides (date, source, cap, closed) VALUES (?, 'admin', ?, ?)")
    .bind(date, cap, closed ? 1 : 0).run();
}
```

- [ ] **Step 3: Write the failing test**

```ts
// tests/routes/public.test.ts
import { describe, it, expect } from "vitest";
import { testApp, seedAdminOverride } from "../helpers";

describe("GET /api/config", () => {
  it("returns sizes and timezone without the studio address", async () => {
    const { fetch } = testApp();
    const r = await fetch("/api/config");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.timezone).toBe("America/New_York");
    expect(body.sizes[0]).toHaveProperty("priceCents");
    expect(JSON.stringify(body)).not.toContain("pickupAddress");
  });
});

describe("GET /api/availability", () => {
  it("returns one entry per day with orderable computed from clock and cutoff", async () => {
    // clock: Tue 2026-09-08 10:00 EDT, before the 11:00 cutoff
    const { fetch } = testApp();
    const r = await fetch("/api/availability?from=2026-09-07&to=2026-09-09");
    expect(r.status).toBe(200);
    const { days } = await r.json() as any;
    expect(days.map((d: any) => [d.date, d.open, d.orderable])).toEqual([
      ["2026-09-07", false, false], // Monday: closed weekday
      ["2026-09-08", true, true],   // today, before cutoff
      ["2026-09-09", true, true],
    ]);
  });
  it("honours admin overrides", async () => {
    await seedAdminOverride("2026-09-10", null, true);
    const { fetch } = testApp();
    const { days } = await (await fetch("/api/availability?from=2026-09-10&to=2026-09-10")).json() as any;
    expect(days[0]).toMatchObject({ open: false, remaining: 0, orderable: false });
  });
  it("rejects bad or oversized ranges", async () => {
    const { fetch } = testApp();
    expect((await fetch("/api/availability?from=2026-9-1&to=2026-09-09")).status).toBe(400);
    expect((await fetch("/api/availability?from=2026-09-01&to=2026-12-31")).status).toBe(400);
    expect((await fetch("/api/availability")).status).toBe(400);
  });
});
```

- [ ] **Step 4: Run, expect failure** — `../src/app` not found.

- [ ] **Step 5: Implement `src/routes/public.ts` (availability + config only) and `src/app.ts`; rewire `src/index.ts`**

```ts
// src/app.ts
import { Hono } from "hono";
import type { Env } from "./env";
import type { Payments } from "./adapters/payments";
import type { StoreConfig } from "./config";
import { publicRoutes } from "./routes/public";

export interface Services { payments: Payments; clock: () => Date; config: StoreConfig }
export type App = Hono<{ Bindings: Env; Variables: { services: Services } }>;

export function buildApp(services: Services): App {
  const app: App = new Hono();
  app.use("*", async (c, next) => { c.set("services", services); await next(); });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/", publicRoutes());
  return app;
}
```

```ts
// src/routes/public.ts
import { Hono } from "hono";
import type { App } from "../app";
import { availabilityFor } from "../core/capacity";
import { isYmd, ymdRange } from "../core/time";
import { loadDefaults } from "../store/settings";
import { getOverrides } from "../store/overrides";
import { countUsed } from "../store/orders";

const MAX_DAYS = 62;

export function publicRoutes(): App {
  const r: App = new Hono();

  r.get("/api/config", (c) => {
    const { config } = c.get("services");
    return c.json({
      timezone: config.timezone,
      sizes: config.sizes,
      studio: { pickupInstructions: config.studio.pickupInstructions },
    });
  });

  r.get("/api/availability", async (c) => {
    const { config, clock } = c.get("services");
    const from = c.req.query("from"), to = c.req.query("to");
    if (!isYmd(from) || !isYmd(to)) return c.json({ error: "from and to must be YYYY-MM-DD" }, 400);
    const dates = ymdRange(from, to);
    if (dates.length === 0 || dates.length > MAX_DAYS) return c.json({ error: `range must be 1..${MAX_DAYS} days` }, 400);
    const [defaults, overrides, used] = await Promise.all([
      loadDefaults(c.env.DB, config.defaults),
      getOverrides(c.env.DB, from, to),
      countUsed(c.env.DB, from, to),
    ]);
    const clk = { now: clock(), tz: config.timezone };
    const days = dates.map((d) => availabilityFor(d, defaults, overrides.get(d) ?? null, used.get(d) ?? 0, clk));
    return c.json({ days });
  });

  return r;
}
```

```ts
// src/index.ts
import type { Env } from "./env";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import type { Payments } from "./adapters/payments";

let cached: ReturnType<typeof buildApp> | null = null;
function appFor(env: Env) {
  if (!cached) {
    const payments: Payments = {
      async createCheckout() { throw new Error("payments not configured"); },
      async parseWebhook() { throw new Error("payments not configured"); },
    };
    cached = buildApp({ payments, clock: () => new Date(), config: loadConfig() });
  }
  return cached;
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => appFor(env).fetch(req, env, ctx),
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {},
};
```

(Task 7 replaces the placeholder `payments` with `StripePayments`.)

- [ ] **Step 6: Run, expect pass, commit**

Run: `npm test` → green, including `tests/smoke.test.ts` which still hits `/api/health` through `index.ts`.

```bash
git add src/app.ts src/routes/public.ts src/adapters/payments.ts src/index.ts tests/helpers.ts tests/routes/public.test.ts
git commit -m "feat(store): /api/config and /api/availability"
```

---

### Task 7: Stripe adapter

**Files:**
- Create: `src/adapters/stripe.ts`, `tests/adapters/stripe.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Payments`, `CheckoutInput`, `WebhookEvent` from Task 6.
- Produces: `export class StripePayments implements Payments { constructor(secretKey: string, webhookSecret: string) }` and `export function toWebhookEvent(e: { type: string; data: { object: any } }): WebhookEvent` (pure mapper, tested).

- [ ] **Step 1: Write the failing test for the mapper**

```ts
// tests/adapters/stripe.test.ts
import { describe, it, expect } from "vitest";
import { toWebhookEvent } from "../../src/adapters/stripe";

describe("toWebhookEvent", () => {
  it("maps completed sessions", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_1" } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_1", paymentIntent: "pi_1" });
  });
  it("maps expired sessions", () => {
    expect(toWebhookEvent({ type: "checkout.session.expired", data: { object: { id: "cs_2" } } }))
      .toEqual({ type: "checkout.session.expired", sessionId: "cs_2" });
  });
  it("maps everything else to other", () => {
    expect(toWebhookEvent({ type: "payment_intent.created", data: { object: {} } })).toEqual({ type: "other" });
  });
  it("tolerates an expanded payment_intent object", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_3", payment_intent: { id: "pi_3" } } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_3", paymentIntent: "pi_3" });
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `src/adapters/stripe.ts`**

```ts
import Stripe from "stripe";
import type { CheckoutInput, CheckoutSession, Payments, WebhookEvent } from "./payments";

export function toWebhookEvent(e: { type: string; data: { object: any } }): WebhookEvent {
  const o = e.data.object;
  if (e.type === "checkout.session.completed") {
    const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id ?? "";
    return { type: "checkout.session.completed", sessionId: o.id, paymentIntent: pi };
  }
  if (e.type === "checkout.session.expired") return { type: "checkout.session.expired", sessionId: o.id };
  return { type: "other" };
}

export class StripePayments implements Payments {
  private stripe: Stripe;
  constructor(secretKey: string, private webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: input.customerEmail,
      client_reference_id: input.orderId,
      metadata: { order_id: input.orderId },
      line_items: input.lineItems.map((li) => ({
        quantity: li.quantity,
        price_data: { currency: "usd", unit_amount: li.amountCents, product_data: { name: li.name } },
      })),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: input.expiresAt,
    });
    if (!session.url) throw new Error("stripe: session has no url");
    return { id: session.id, url: session.url };
  }

  async parseWebhook(rawBody: string, signature: string): Promise<WebhookEvent> {
    const event = await this.stripe.webhooks.constructEventAsync(
      rawBody, signature, this.webhookSecret, undefined, Stripe.createSubtleCryptoProvider(),
    );
    return toWebhookEvent(event as any);
  }
}
```

- [ ] **Step 4: Wire it in `src/index.ts`**

Replace the placeholder `payments` object with:

```ts
import { StripePayments } from "./adapters/stripe";
// inside appFor:
const payments = new StripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
```

- [ ] **Step 5: Run, expect pass, commit**

```bash
git add src/adapters/stripe.ts tests/adapters/stripe.test.ts src/index.ts
git commit -m "feat(store): Stripe payments adapter"
```

---

### Task 8: Checkout endpoint with atomic hold

**Files:**
- Modify: `src/routes/public.ts`
- Test: `tests/routes/public.test.ts` (append)

**Interfaces:**
- Consumes: `tryInsertHeldOrder`, `attachSession`, `cancelOrder` (Task 5); `Payments` (Task 6); `capFor`, `isOrderable` (Task 4); `sizeById` (Task 2).
- Produces: `POST /api/checkout` body `{ sizeId, date, fulfillment: "pickup", customer: { name, email, phone? }, note? }` → `200 { url }`; `400 { error }` on validation; `409 { error: "sold_out" }`; `503 { error: "payments_unavailable" }`. Success URL is `${SITE_URL}/thanks?order=<id>`, cancel URL `${SITE_URL}/#order`.

- [ ] **Step 1: Append failing tests**

```ts
// tests/routes/public.test.ts (append)
import { env } from "cloudflare:test";

const good = {
  sizeId: "bouquet", date: "2026-09-09", fulfillment: "pickup",
  customer: { name: "Pat Lee", email: "pat@example.com", phone: "518-555-0100" }, note: "yellows please",
};
const post = (fetch: any, body: unknown) =>
  fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/checkout", () => {
  it("holds a slot, creates a session with correct line items, returns the url", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, good);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://checkout.example/1" });
    const c = payments.created[0];
    expect(c.lineItems).toEqual([{ name: "Bouquet — pickup Wed Sep 9", amountCents: 8500, quantity: 1 }]);
    expect(c.expiresAt).toBe(Math.floor(new Date("2026-09-08T14:30:00Z").getTime() / 1000));
    expect(c.successUrl).toBe(`https://thebullandbloom.com/thanks?order=${c.orderId}`);
    const row = await env.DB.prepare("SELECT status, stripe_session_id, note FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ status: "held", stripe_session_id: "cs_1", note: "yellows please" });
  });
  it("returns 409 sold_out when the day is full and does not call Stripe", async () => {
    await seedAdminOverride("2026-09-16", 1, false);
    const { fetch, payments } = testApp();
    expect((await post(fetch, { ...good, date: "2026-09-16" })).status).toBe(200);
    const r = await post(fetch, { ...good, date: "2026-09-16" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "sold_out" });
    expect(payments.created.length).toBe(1);
  });
  it("rejects a same-day order after the cutoff", async () => {
    const { fetch } = testApp(new Date("2026-09-08T16:00:00Z")); // 12:00 EDT
    const r = await post(fetch, { ...good, date: "2026-09-08" });
    expect(r.status).toBe(409);
  });
  it("validates input", async () => {
    const { fetch } = testApp();
    expect((await post(fetch, { ...good, sizeId: "giant" })).status).toBe(400);
    expect((await post(fetch, { ...good, fulfillment: "delivery" })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "", email: "pat@example.com" } })).status).toBe(400);
    expect((await post(fetch, { ...good, customer: { name: "Pat", email: "not-an-email" } })).status).toBe(400);
    expect((await post(fetch, { ...good, note: "x".repeat(501) })).status).toBe(400);
    expect((await fetch("/api/checkout", { method: "POST", body: "not json" })).status).toBe(400);
  });
  it("releases the hold and returns 503 if Stripe fails", async () => {
    const { fetch, payments } = testApp();
    payments.failNext = true;
    const r = await post(fetch, { ...good, date: "2026-09-17" });
    expect(r.status).toBe(503);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE date = '2026-09-17' AND status = 'held'").first<any>();
    expect(n.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect failure** (404 from missing route).

- [ ] **Step 3: Add the route to `src/routes/public.ts`**

Add imports:

```ts
import { capFor, isOrderable } from "../core/capacity";
import { sizeById } from "../config";
import { tryInsertHeldOrder, attachSession, cancelOrder } from "../store/orders";
```

Add helpers above `publicRoutes`:

```ts
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function humanDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${DAY[weekdayOf(ymd)]} ${MON[m - 1]} ${d}`;
}

interface CheckoutBody {
  sizeId: string; date: string; fulfillment: "pickup";
  customer: { name: string; email: string; phone?: string }; note?: string;
}

function parseCheckout(raw: unknown): { ok: true; body: CheckoutBody } | { ok: false; error: string } {
  const b = raw as any;
  if (!b || typeof b !== "object") return { ok: false, error: "body must be an object" };
  if (typeof b.sizeId !== "string") return { ok: false, error: "sizeId required" };
  if (!isYmd(b.date)) return { ok: false, error: "date must be YYYY-MM-DD" };
  if (b.fulfillment !== "pickup") return { ok: false, error: "only pickup is available right now" };
  const c = b.customer;
  if (!c || typeof c.name !== "string" || c.name.trim().length < 1 || c.name.length > 120) return { ok: false, error: "name required" };
  if (typeof c.email !== "string" || !EMAIL.test(c.email) || c.email.length > 200) return { ok: false, error: "valid email required" };
  if (c.phone !== undefined && (typeof c.phone !== "string" || c.phone.length > 40)) return { ok: false, error: "phone too long" };
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) return { ok: false, error: "note must be 500 characters or fewer" };
  return { ok: true, body: { sizeId: b.sizeId, date: b.date, fulfillment: "pickup",
    customer: { name: c.name.trim(), email: c.email.trim(), phone: c.phone?.trim() || undefined }, note: b.note?.trim() || undefined } };
}
```

Add `weekdayOf` to the `../core/time` import. Then the route inside `publicRoutes()`:

```ts
  r.post("/api/checkout", async (c) => {
    const { config, clock, payments } = c.get("services");
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const parsed = parseCheckout(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { body } = parsed;
    const size = sizeById(config, body.sizeId);
    if (!size) return c.json({ error: "unknown size" }, 400);

    const [defaults, overrides, used] = await Promise.all([
      loadDefaults(c.env.DB, config.defaults),
      getOverrides(c.env.DB, body.date, body.date),
      countUsed(c.env.DB, body.date, body.date),
    ]);
    const now = clock();
    const cap = capFor(body.date, defaults, overrides.get(body.date) ?? null);
    if (!isOrderable(body.date, cap - (used.get(body.date) ?? 0), defaults, { now, tz: config.timezone })) {
      return c.json({ error: "sold_out" }, 409);
    }

    const nowSec = Math.floor(now.getTime() / 1000);
    const holdUntil = nowSec + config.holdMinutes * 60;
    const orderId = crypto.randomUUID();
    const inserted = await tryInsertHeldOrder(c.env.DB, {
      id: orderId, date: body.date, sizeId: size.id, fulfillment: "pickup",
      customerName: body.customer.name, customerEmail: body.customer.email, customerPhone: body.customer.phone ?? null,
      note: body.note ?? null, bouquetCents: size.priceCents, deliveryCents: 0,
    }, cap, nowSec, holdUntil);
    if (!inserted) return c.json({ error: "sold_out" }, 409);

    try {
      const session = await payments.createCheckout({
        orderId, customerEmail: body.customer.email,
        lineItems: [{ name: `${size.name} — pickup ${humanDate(body.date)}`, amountCents: size.priceCents, quantity: 1 }],
        successUrl: `${c.env.SITE_URL}/thanks?order=${orderId}`,
        cancelUrl: `${c.env.SITE_URL}/#order`,
        expiresAt: holdUntil,
      });
      await attachSession(c.env.DB, orderId, session.id);
      return c.json({ url: session.url });
    } catch (err) {
      await cancelOrder(c.env.DB, orderId);
      console.error("checkout: payments failed", err);
      return c.json({ error: "payments_unavailable" }, 503);
    }
  });
```

- [ ] **Step 4: Run, expect pass, commit**

```bash
git add src/routes/public.ts tests/routes/public.test.ts
git commit -m "feat(store): POST /api/checkout with atomic hold and Stripe session"
```

---

### Task 9: Stripe webhook

**Files:**
- Create: `src/routes/webhooks.ts`, `tests/routes/webhooks.test.ts`
- Modify: `src/app.ts` (mount)

**Interfaces:**
- Consumes: `Payments.parseWebhook`, `markPaidBySession`, `cancelHeldBySession`.
- Produces: `POST /webhooks/stripe` → 200 `{ received: true, applied: "paid" | "cancelled" | "ignored" }`; 400 on bad signature or missing header. Later plans hook calendar and email onto the "paid" branch.

- [ ] **Step 1: Write the failing test**

```ts
// tests/routes/webhooks.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testApp } from "../helpers";

async function heldOrder(id: string, session: string) {
  await env.DB.prepare(
    `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id, hold_expires_at)
     VALUES (?, 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, ?, 99)`,
  ).bind(id, session).run();
}
const hook = (fetch: any, sig = "good") =>
  fetch("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sig }, body: "{}" });

describe("POST /webhooks/stripe", () => {
  it("marks the order paid on completion and is idempotent", async () => {
    await heldOrder("w1", "cs_w1");
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.completed", sessionId: "cs_w1", paymentIntent: "pi_w1" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "paid" });
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
    const row = await env.DB.prepare("SELECT status, stripe_payment_intent, hold_expires_at FROM orders WHERE id = 'w1'").first<any>();
    expect(row).toEqual({ status: "paid", stripe_payment_intent: "pi_w1", hold_expires_at: null });
  });
  it("cancels a held order on expiry", async () => {
    await heldOrder("w2", "cs_w2");
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "checkout.session.expired", sessionId: "cs_w2" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "cancelled" });
  });
  it("rejects bad signatures and missing headers", async () => {
    const { fetch } = testApp();
    expect((await hook(fetch, "bad")).status).toBe(400);
    expect((await fetch("/webhooks/stripe", { method: "POST", body: "{}" })).status).toBe(400);
  });
  it("acknowledges unrelated events", async () => {
    const { fetch, payments } = testApp();
    payments.nextEvent = { type: "other" };
    expect(await (await hook(fetch)).json()).toEqual({ received: true, applied: "ignored" });
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement and mount**

```ts
// src/routes/webhooks.ts
import { Hono } from "hono";
import type { App } from "../app";
import { markPaidBySession, cancelHeldBySession } from "../store/orders";

export function webhookRoutes(): App {
  const r: App = new Hono();
  r.post("/webhooks/stripe", async (c) => {
    const { payments } = c.get("services");
    const sig = c.req.header("stripe-signature");
    if (!sig) return c.json({ error: "missing signature" }, 400);
    let event;
    try { event = await payments.parseWebhook(await c.req.text(), sig); }
    catch { return c.json({ error: "bad signature" }, 400); }

    if (event.type === "checkout.session.completed") {
      const order = await markPaidBySession(c.env.DB, event.sessionId, event.paymentIntent);
      return c.json({ received: true, applied: order ? "paid" : "ignored" });
    }
    if (event.type === "checkout.session.expired") {
      const did = await cancelHeldBySession(c.env.DB, event.sessionId);
      return c.json({ received: true, applied: did ? "cancelled" : "ignored" });
    }
    return c.json({ received: true, applied: "ignored" });
  });
  return r;
}
```

In `src/app.ts` add `import { webhookRoutes } from "./routes/webhooks";` and `app.route("/", webhookRoutes());` after the public routes.

- [ ] **Step 4: Run, expect pass, commit**

```bash
git add src/routes/webhooks.ts src/app.ts tests/routes/webhooks.test.ts
git commit -m "feat(store): Stripe webhook marks orders paid or releases holds"
```

---

### Task 10: Scheduled hold expiry

**Files:**
- Create: `src/scheduled.ts`, `tests/scheduled.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `export async function runScheduled(env: Env, now: Date): Promise<{ expiredHolds: number }>`. Plan 2 adds calendar sync here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scheduled.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runScheduled } from "../src/scheduled";

describe("runScheduled", () => {
  it("expires stale holds and leaves fresh ones", async () => {
    const now = 1_800_000_000;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, hold_expires_at)
        VALUES ('s1', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'A', 'a@example.com', 8500, ?)`).bind(now - 1),
      env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, hold_expires_at)
        VALUES ('s2', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'B', 'b@example.com', 8500, ?)`).bind(now + 600),
    ]);
    expect(await runScheduled(env, new Date(now * 1000))).toEqual({ expiredHolds: 1 });
    const s = await env.DB.prepare("SELECT id, status FROM orders WHERE id IN ('s1','s2') ORDER BY id").all<any>();
    expect(s.results).toEqual([{ id: "s1", status: "cancelled" }, { id: "s2", status: "held" }]);
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
// src/scheduled.ts
import type { Env } from "./env";
import { expireHolds } from "./store/orders";

export async function runScheduled(env: Env, now: Date): Promise<{ expiredHolds: number }> {
  const expiredHolds = await expireHolds(env.DB, Math.floor(now.getTime() / 1000));
  return { expiredHolds };
}
```

In `src/index.ts`:

```ts
import { runScheduled } from "./scheduled";
// ...
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, new Date()).then((r) => console.log("scheduled", JSON.stringify(r))));
  },
```

- [ ] **Step 4: Run, expect pass, commit**

```bash
git add src/scheduled.ts src/index.ts tests/scheduled.test.ts
git commit -m "feat(store): cron expires stale holds"
```

---

### Task 11: Admin session cookie

**Files:**
- Create: `src/admin/session.ts`, `tests/admin/session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const COOKIE = "bb_admin";
  export async function makeSession(secret: string, nowSec: number, ttlSec: number): Promise<string>   // "<exp>.<base64url hmac>"
  export async function verifySession(token: string | undefined, secret: string, nowSec: number): Promise<boolean>
  export async function passcodeMatches(given: string, expected: string): Promise<boolean>              // constant-time via hashing
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin/session.test.ts
import { describe, it, expect } from "vitest";
import { makeSession, verifySession, passcodeMatches } from "../../src/admin/session";

describe("admin session", () => {
  it("verifies a fresh token and rejects an expired one", async () => {
    const t = await makeSession("s", 1000, 60);
    expect(await verifySession(t, "s", 1030)).toBe(true);
    expect(await verifySession(t, "s", 1061)).toBe(false);
  });
  it("rejects tampering, wrong secret, and garbage", async () => {
    const t = await makeSession("s", 1000, 60);
    const [exp, sig] = t.split(".");
    expect(await verifySession(`${Number(exp) + 9999}.${sig}`, "s", 1030)).toBe(false);
    expect(await verifySession(t, "other", 1030)).toBe(false);
    expect(await verifySession("nope", "s", 1030)).toBe(false);
    expect(await verifySession(undefined, "s", 1030)).toBe(false);
  });
  it("compares passcodes", async () => {
    expect(await passcodeMatches("open-sesame-1234", "open-sesame-1234")).toBe(true);
    expect(await passcodeMatches("open-sesame-1235", "open-sesame-1234")).toBe(false);
    expect(await passcodeMatches("", "open-sesame-1234")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
// src/admin/session.ts
export const COOKIE = "bb_admin";
const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function makeSession(secret: string, nowSec: number, ttlSec: number): Promise<string> {
  const exp = String(nowSec + ttlSec);
  return `${exp}.${await hmac(secret, exp)}`;
}

export async function verifySession(token: string | undefined, secret: string, nowSec: number): Promise<boolean> {
  if (!token) return false;
  const i = token.indexOf(".");
  if (i < 0) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) <= nowSec) return false;
  const expected = await hmac(secret, exp);
  return equal(await sha256(sig), await sha256(expected));
}

export async function passcodeMatches(given: string, expected: string): Promise<boolean> {
  if (!given || !expected) return false;
  return equal(await sha256(given), await sha256(expected));
}
```

- [ ] **Step 4: Run, expect pass, commit**

```bash
git add src/admin/session.ts tests/admin/session.test.ts
git commit -m "feat(store): signed admin session cookie"
```

---

### Task 12: Admin API

**Files:**
- Create: `src/routes/admin.ts`, `tests/routes/admin.test.ts`
- Modify: `src/app.ts` (mount)

**Interfaces:**
- Consumes: Task 11 session; store modules; `availabilityFor`.
- Produces (all under `/admin/api`, JSON; every route except login requires a valid `bb_admin` cookie, else 401):
  - `POST /login { passcode }` → 204 + `Set-Cookie` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 30 days). Wrong passcode: waits 1 s, 401.
  - `POST /logout` → 204, clears cookie.
  - `GET /month?from&to` → `{ days: Array<Availability & { closed: boolean; overrideCap: number | null; subscriptionCount: number; paidCount: number; heldCount: number }> }`
  - `PUT /days/:date { cap?: number | null; closed?: boolean }` → 200 `{ ok: true }` (missing fields keep current admin values). `DELETE /days/:date` → 204.
  - `GET /settings` → `Defaults`; `PUT /settings { cap?, cutoff?, openWeekdays? }` → 200 with the merged `Defaults`. Validates like config.
  - `GET /orders?date` → `{ orders: Order[] }` (all statuses, subscription rows included, for the day).
  - `POST /orders/:id/done` → 200 `{ ok: true }` (paid → done only; 409 otherwise). `POST /orders/:id/undone` reverses (done → paid).

- [ ] **Step 1: Write the failing test**

```ts
// tests/routes/admin.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testApp, seedAdminOverride } from "../helpers";

async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  expect(r.status).toBe(204);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" } });
}

describe("admin auth", () => {
  it("refuses without a cookie and with a wrong passcode", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/month?from=2026-09-01&to=2026-09-02")).status).toBe(401);
    const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "wrong" }) });
    expect(r.status).toBe(401);
  });
  it("sets an HttpOnly cookie on login", async () => {
    const { fetch } = testApp();
    const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "open-sesame-1234" }) });
    expect(r.headers.get("set-cookie")).toMatch(/bb_admin=.*HttpOnly/);
  });
});

describe("admin month and days", () => {
  it("reports counts and applies day edits", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    await env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, source)
      VALUES ('m1', 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'A', 'a@example.com', 8500, 'one_time'),
             ('m2', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'B', 'b@example.com', 8500, 'one_time'),
             ('m3', 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'C', 'c@example.com', 8500, 'subscription')`).run();
    let { days } = await (await as("/admin/api/month?from=2026-09-09&to=2026-09-09")).json() as any;
    expect(days[0]).toMatchObject({ used: 2, paidCount: 1, heldCount: 1, subscriptionCount: 1, closed: false, overrideCap: null });

    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ cap: 6 }) })).status).toBe(200);
    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ closed: true }) })).status).toBe(200);
    ({ days } = await (await as("/admin/api/month?from=2026-09-09&to=2026-09-09")).json() as any);
    expect(days[0]).toMatchObject({ overrideCap: 6, closed: true, cap: 0 });

    expect((await as("/admin/api/days/2026-09-09", { method: "DELETE" })).status).toBe(204);
    ({ days } = await (await as("/admin/api/month?from=2026-09-09&to=2026-09-09")).json() as any);
    expect(days[0]).toMatchObject({ overrideCap: null, closed: false, cap: 4 });
  });
  it("validates day edits", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/days/2026-9-9", { method: "PUT", body: JSON.stringify({ cap: 1 }) })).status).toBe(400);
    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ cap: -1 }) })).status).toBe(400);
    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ cap: 2.5 }) })).status).toBe(400);
  });
});

describe("admin settings and orders", () => {
  it("reads and updates settings with validation", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    expect(await (await as("/admin/api/settings")).json()).toEqual({ cap: 4, cutoff: "11:00", openWeekdays: [2, 3, 4, 5, 6] });
    const r = await as("/admin/api/settings", { method: "PUT", body: JSON.stringify({ cap: 7, cutoff: "10:15" }) });
    expect(await r.json()).toEqual({ cap: 7, cutoff: "10:15", openWeekdays: [2, 3, 4, 5, 6] });
    expect((await as("/admin/api/settings", { method: "PUT", body: JSON.stringify({ cutoff: "27:00" }) })).status).toBe(400);
    expect((await as("/admin/api/settings", { method: "PUT", body: JSON.stringify({ openWeekdays: [7] }) })).status).toBe(400);
  });
  it("lists a day's orders and toggles done", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    await env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents)
      VALUES ('d1', 1, 'paid', '2026-09-10', 'posy', 'pickup', 'A', 'a@example.com', 5500),
             ('d2', 2, 'held', '2026-09-10', 'posy', 'pickup', 'B', 'b@example.com', 5500)`).run();
    const { orders } = await (await as("/admin/api/orders?date=2026-09-10")).json() as any;
    expect(orders.map((o: any) => o.id)).toEqual(["d1", "d2"]);
    expect((await as("/admin/api/orders/d1/done", { method: "POST" })).status).toBe(200);
    expect((await as("/admin/api/orders/d2/done", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/d1/undone", { method: "POST" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id='d1'").first<any>()).status).toBe("paid");
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `src/routes/admin.ts`**

```ts
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { App } from "../app";
import { COOKIE, makeSession, verifySession, passcodeMatches } from "../admin/session";
import { availabilityFor, type Defaults } from "../core/capacity";
import { isYmd, ymdRange } from "../core/time";
import { loadDefaults, saveDefaults } from "../store/settings";
import { getOverrides, putAdminOverride, clearAdminOverride } from "../store/overrides";
import { countUsed, listOrders, getOrder, setStatus } from "../store/orders";

const TTL = 30 * 24 * 3600;
const MAX_DAYS = 62;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validCap(v: unknown): v is number | null {
  return v === null || (Number.isInteger(v) && (v as number) >= 0);
}

function validateSettingsPatch(p: any): { ok: true; patch: Partial<Defaults> } | { ok: false; error: string } {
  const patch: Partial<Defaults> = {};
  if (p.cap !== undefined) { if (!validCap(p.cap) || p.cap === null) return { ok: false, error: "cap must be a non-negative integer" }; patch.cap = p.cap; }
  if (p.cutoff !== undefined) { if (typeof p.cutoff !== "string" || !HM.test(p.cutoff)) return { ok: false, error: "cutoff must be HH:MM" }; patch.cutoff = p.cutoff; }
  if (p.openWeekdays !== undefined) {
    if (!Array.isArray(p.openWeekdays) || !p.openWeekdays.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))
      return { ok: false, error: "openWeekdays must be integers 0..6" };
    patch.openWeekdays = [...new Set(p.openWeekdays as number[])].sort();
  }
  return { ok: true, patch };
}

export function adminRoutes(): App {
  const r: App = new Hono();

  r.post("/admin/api/login", async (c) => {
    let body: any = {};
    try { body = await c.req.json(); } catch { /* fallthrough */ }
    if (!(await passcodeMatches(String(body.passcode ?? ""), c.env.ADMIN_PASSCODE))) {
      await new Promise((res) => setTimeout(res, 1000));
      return c.json({ error: "wrong passcode" }, 401);
    }
    const nowSec = Math.floor(c.get("services").clock().getTime() / 1000);
    setCookie(c, COOKIE, await makeSession(c.env.ADMIN_SECRET, nowSec, TTL), {
      httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: TTL,
    });
    return c.body(null, 204);
  });

  r.post("/admin/api/logout", (c) => { deleteCookie(c, COOKIE, { path: "/" }); return c.body(null, 204); });

  r.use("/admin/api/*", async (c, next) => {
    if (c.req.path === "/admin/api/login") return next();
    const nowSec = Math.floor(c.get("services").clock().getTime() / 1000);
    if (!(await verifySession(getCookie(c, COOKIE), c.env.ADMIN_SECRET, nowSec))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  r.get("/admin/api/month", async (c) => {
    const { config, clock } = c.get("services");
    const from = c.req.query("from"), to = c.req.query("to");
    if (!isYmd(from) || !isYmd(to)) return c.json({ error: "from and to must be YYYY-MM-DD" }, 400);
    const dates = ymdRange(from, to);
    if (dates.length === 0 || dates.length > MAX_DAYS) return c.json({ error: `range must be 1..${MAX_DAYS} days` }, 400);
    const [defaults, overrides, used, adminRows, counts] = await Promise.all([
      loadDefaults(c.env.DB, config.defaults),
      getOverrides(c.env.DB, from, to),
      countUsed(c.env.DB, from, to),
      c.env.DB.prepare("SELECT date, cap FROM day_overrides WHERE source = 'admin' AND date BETWEEN ? AND ?").bind(from, to).all<{ date: string; cap: number | null }>(),
      c.env.DB.prepare(
        `SELECT date, source, status, COUNT(*) AS n FROM orders WHERE date BETWEEN ? AND ? AND status IN ('held','paid','done') GROUP BY date, source, status`,
      ).bind(from, to).all<{ date: string; source: string; status: string; n: number }>(),
    ]);
    const adminCap = new Map(adminRows.results.map((x) => [x.date, x.cap]));
    const clk = { now: clock(), tz: config.timezone };
    const days = dates.map((d) => {
      const o = overrides.get(d) ?? null;
      const rows = counts.results.filter((x) => x.date === d);
      const n = (src: string, st: string) => rows.filter((x) => x.source === src && x.status === st).reduce((a, x) => a + x.n, 0);
      return {
        ...availabilityFor(d, defaults, o, used.get(d) ?? 0, clk),
        closed: o?.closed ?? false,
        overrideCap: adminCap.get(d) ?? null,
        paidCount: n("one_time", "paid") + n("one_time", "done"),
        heldCount: n("one_time", "held"),
        subscriptionCount: n("subscription", "paid") + n("subscription", "done"),
      };
    });
    return c.json({ days });
  });

  r.put("/admin/api/days/:date", async (c) => {
    const date = c.req.param("date");
    if (!isYmd(date)) return c.json({ error: "bad date" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (body.cap !== undefined && !validCap(body.cap)) return c.json({ error: "cap must be a non-negative integer or null" }, 400);
    if (body.closed !== undefined && typeof body.closed !== "boolean") return c.json({ error: "closed must be boolean" }, 400);
    const cur = await c.env.DB.prepare("SELECT cap, closed FROM day_overrides WHERE date = ? AND source = 'admin'").bind(date).first<{ cap: number | null; closed: number }>();
    await putAdminOverride(c.env.DB, date, {
      cap: body.cap !== undefined ? body.cap : cur?.cap ?? null,
      closed: body.closed !== undefined ? body.closed : Boolean(cur?.closed),
    });
    return c.json({ ok: true });
  });

  r.delete("/admin/api/days/:date", async (c) => {
    const date = c.req.param("date");
    if (!isYmd(date)) return c.json({ error: "bad date" }, 400);
    await clearAdminOverride(c.env.DB, date);
    return c.body(null, 204);
  });

  r.get("/admin/api/settings", async (c) => c.json(await loadDefaults(c.env.DB, c.get("services").config.defaults)));

  r.put("/admin/api/settings", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const v = validateSettingsPatch(body);
    if (!v.ok) return c.json({ error: v.error }, 400);
    await saveDefaults(c.env.DB, v.patch);
    return c.json(await loadDefaults(c.env.DB, c.get("services").config.defaults));
  });

  r.get("/admin/api/orders", async (c) => {
    const date = c.req.query("date");
    if (!isYmd(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    return c.json({ orders: await listOrders(c.env.DB, date) });
  });

  r.post("/admin/api/orders/:id/done", async (c) => {
    const o = await getOrder(c.env.DB, c.req.param("id"));
    if (!o) return c.json({ error: "not found" }, 404);
    if (o.status !== "paid") return c.json({ error: `cannot mark ${o.status} order done` }, 409);
    await setStatus(c.env.DB, o.id, "done");
    return c.json({ ok: true });
  });

  r.post("/admin/api/orders/:id/undone", async (c) => {
    const o = await getOrder(c.env.DB, c.req.param("id"));
    if (!o) return c.json({ error: "not found" }, 404);
    if (o.status !== "done") return c.json({ error: `order is ${o.status}` }, 409);
    await setStatus(c.env.DB, o.id, "paid");
    return c.json({ ok: true });
  });

  return r;
}
```

Mount in `src/app.ts`: `import { adminRoutes } from "./routes/admin";` and `app.route("/", adminRoutes());`.

Note on the middleware: Hono runs `r.use("/admin/api/*")` for routes registered after it, and `login` is registered before it; the explicit path check is belt-and-braces.

- [ ] **Step 4: Run, expect pass, commit**

```bash
git add src/routes/admin.ts src/app.ts tests/routes/admin.test.ts
git commit -m "feat(store): admin API — login, month grid, day overrides, settings, orders"
```

---

### Task 13: Storefront menu and order flow

**Files:**
- Modify: `site/index.html` (replace the `#services` and `#how` sections; keep `#about`, `#subscribe`, `#contact`)
- Create: `site/store.js`, `site/thanks.html`

**Interfaces:**
- Consumes: `GET /api/config`, `GET /api/availability`, `POST /api/checkout` (Tasks 6, 8).
- Produces: the customer-facing order flow. No tests beyond manual verification in `npm run dev`; the logic that matters is server-side and already tested.

- [ ] **Step 1: Replace the `#services` section in `site/index.html`**

Replace everything from `<section id="services">` through its `</section>` with:

```html
  <section id="services">
    <p class="eyebrow">The menu</p>
    <h2>Designer's choice, three sizes</h2>
    <p class="intro">Every bouquet is built from whatever is best that morning. Pick a size, pick a day, and Anthony does the rest. Pickup is free.</p>
    <ul class="services menu" id="menu" aria-live="polite"></ul>
  </section>

  <section id="order">
    <p class="eyebrow">Order</p>
    <h2>Pick a day</h2>
    <form class="form" id="order-form" novalidate>
      <fieldset class="full sizes" id="size-picker"><legend>Size</legend></fieldset>
      <fieldset class="full days" id="day-picker"><legend>Day</legend><p class="form-note" id="day-note"></p></fieldset>
      <label>Name<input type="text" name="name" required autocomplete="name"></label>
      <label>Email<input type="email" name="email" required autocomplete="email"></label>
      <label>Phone <span class="opt">(optional)</span><input type="tel" name="phone" autocomplete="tel"></label>
      <label class="full">Anything for Anthony? <span class="opt">(colors you love, the occasion, a card message)</span><textarea name="note" rows="3" maxlength="500"></textarea></label>
      <div class="full"><button class="btn" type="submit" id="pay-btn" disabled>Continue to payment</button><p class="form-status" role="status" aria-live="polite" id="order-status"></p></div>
    </form>
  </section>
```

Delete the `#how` section entirely (the store replaces it). In the `#subscribe` section change the eyebrow copy to `Weekly bouquets` and leave the form as is; Plan 4 replaces it.

- [ ] **Step 2: Add styles inside the existing `<style>` block**

```css
  .menu li{cursor:default}
  .menu .price{font-family:var(--display);font-size:1.3rem;margin-top:.3rem}
  fieldset{border:0;padding:0;margin:0 0 1rem}
  legend{font-family:var(--display);letter-spacing:.2em;text-transform:uppercase;font-size:.8rem;color:var(--sepia);margin-bottom:.5rem}
  .sizes label,.days label{display:inline-flex;align-items:center;gap:.4rem;margin:0 .8rem .6rem 0;padding:.5rem .9rem;border:1px solid var(--rule);cursor:pointer}
  .sizes input,.days input{margin:0}
  .sizes label:has(input:checked),.days label:has(input:checked){border-color:var(--ink);background:var(--paper-deep)}
  .days label.sold{opacity:.45;cursor:not-allowed;text-decoration:line-through}
  .form-note{font-size:.95rem;color:var(--sepia);margin:.25rem 0 0}
```

- [ ] **Step 3: Write `site/store.js`**

```js
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var menu = $('#menu'), sizes = $('#size-picker'), days = $('#day-picker'), dayNote = $('#day-note');
  var form = $('#order-form'), pay = $('#pay-btn'), status = $('#order-status');
  if (!form) return;

  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function human(s) {
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function renderSizes(cfg) {
    menu.innerHTML = '';
    sizes.querySelectorAll('label').forEach(function (l) { l.remove(); });
    cfg.sizes.forEach(function (s, i) {
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
    pay.disabled = !any;
  }

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
    if (!form.reportValidity()) return;
    pay.disabled = true; status.textContent = 'One moment…';
    fetch('/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sizeId: f.get('sizeId'), date: f.get('date'), fulfillment: 'pickup',
        customer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
        note: f.get('note') || undefined
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.ok) { window.location.href = r.body.url; return; }
        pay.disabled = false;
        if (r.status === 409) { status.textContent = 'That day just filled up. Pick another.'; load(); }
        else if (r.status === 503) { status.textContent = 'Payments are briefly unavailable. Try again in a minute.'; }
        else { status.textContent = r.body.error || 'Something went wrong.'; }
      })
      .catch(function () { pay.disabled = false; status.textContent = 'Something went wrong. Try again.'; });
  });

  load();
})();
```

Add `<script src="store.js" defer></script>` in `<head>` after the font link. The existing inline Formspree script stays.

- [ ] **Step 4: Write `site/thanks.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thank you — The Bull and Bloom</title>
<link rel="icon" href="assets/logo.jpg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=EB+Garamond&display=swap">
<style>
  body{margin:0;background:#F6F0E5;color:#3A2E24;font-family:"EB Garamond",Garamond,Georgia,serif;font-size:1.125rem;line-height:1.6}
  main{max-width:36rem;margin:0 auto;padding:4rem 1.5rem;text-align:center}
  h1{font-family:"Cormorant Garamond",Garamond,serif;font-weight:500;font-size:2.4rem;margin:0 0 1rem}
  a{color:inherit}
</style>
</head>
<body>
<main>
  <h1>Thank you</h1>
  <p>Your bouquet is on Anthony's list. A receipt is on its way from Stripe, and Anthony will text or email if he has a question.</p>
  <p>Questions? <a href="mailto:thebullandbloom@gmail.com">thebullandbloom@gmail.com</a> · <a href="tel:+15183340517">(518) 334-0517</a></p>
  <p><a href="/">Back to the site</a></p>
</main>
</body>
</html>
```

- [ ] **Step 5: Manual verification**

Create `.dev.vars` (gitignored) with `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…`, `ADMIN_PASSCODE=…`, `ADMIN_SECRET=…` using a Stripe test-mode key. Then:

```bash
npx wrangler d1 migrations apply bullandbloom --local
npm run dev
```

Open http://localhost:8787. Confirm: three sizes render with prices; day chips show open days only, disabled when sold out; submitting goes to a Stripe test checkout; paying with card `4242 4242 4242 4242` lands on `/thanks`. In a second terminal `stripe listen --forward-to localhost:8787/webhooks/stripe` and confirm the order flips to `paid` (`npx wrangler d1 execute bullandbloom --local --command "select id,status from orders"`).

- [ ] **Step 6: Run tests, commit**

`npm test` still green (the smoke test asserts the home page contains "The Bull and Bloom").

```bash
git add site/index.html site/store.js site/thanks.html
git commit -m "feat(site): menu, day picker, and pickup checkout flow"
```

---

### Task 14: Admin page

**Files:**
- Create: `site/admin/index.html`

**Interfaces:**
- Consumes: the `/admin/api/*` routes from Task 12.

- [ ] **Step 1: Write `site/admin/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Bull and Bloom — Admin</title>
<style>
  :root{--paper:#F6F0E5;--ink:#3A2E24;--sepia:#8B7662;--rule:#CDBFAD;--closed:#E6C9C9;--full:#F1E1B8}
  body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.5 -apple-system,system-ui,Georgia,serif}
  main{max-width:44rem;margin:0 auto;padding:1rem}
  h1{font-weight:500;font-size:1.4rem;margin:.5rem 0 1rem}
  button{font:inherit;padding:.5rem .9rem;border:1px solid var(--ink);background:#fff;cursor:pointer}
  input,select{font:inherit;padding:.4rem;border:1px solid var(--rule)}
  .row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin:.6rem 0}
  .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
  .grid .h{text-align:center;font-size:.8rem;color:var(--sepia)}
  .day{min-height:3.6rem;padding:.3rem;border:1px solid var(--rule);background:#fff;cursor:pointer;font-size:.85rem}
  .day.off{background:transparent;color:var(--sepia)}
  .day.closed{background:var(--closed)}
  .day.full{background:var(--full)}
  .day.sel{outline:2px solid var(--ink)}
  .day b{display:block}
  .panel{border:1px solid var(--rule);padding:1rem;margin-top:1rem;background:#fff}
  .order{border-top:1px solid var(--rule);padding:.6rem 0}
  .order small{color:var(--sepia)}
  .status{color:var(--sepia);font-size:.9rem}
  [hidden]{display:none!important}
</style>
</head>
<body>
<main>
  <h1>The Bull and Bloom — admin</h1>

  <form id="login" class="row">
    <input type="password" name="passcode" placeholder="Passcode" autocomplete="current-password" required>
    <button type="submit">Sign in</button><span class="status" id="login-status"></span>
  </form>

  <section id="app" hidden>
    <div class="row">
      <button id="prev">‹</button><strong id="month-label"></strong><button id="next">›</button>
      <span style="flex:1"></span>
      <button id="settings-btn">Settings</button><button id="logout">Sign out</button>
    </div>
    <div class="grid" id="grid"></div>
    <p class="status">Tap a day. Number is one-time orders / cap; “+n” is subscription bouquets. Pink = closed, yellow = full.</p>

    <div class="panel" id="day-panel" hidden>
      <h2 id="day-title" style="margin:0 0 .5rem;font-size:1.1rem;font-weight:500"></h2>
      <div class="row">
        <label>Cap for this day <input type="number" id="day-cap" min="0" style="width:5rem"></label>
        <button id="day-cap-save">Save cap</button>
        <button id="day-cap-clear">Use default</button>
      </div>
      <div class="row">
        <button id="day-toggle"></button>
      </div>
      <div id="orders"></div>
    </div>

    <div class="panel" id="settings-panel" hidden>
      <h2 style="margin:0 0 .5rem;font-size:1.1rem;font-weight:500">Defaults</h2>
      <div class="row"><label>Bouquets per day <input type="number" id="s-cap" min="0" style="width:5rem"></label></div>
      <div class="row"><label>Same-day cutoff <input type="time" id="s-cutoff"></label></div>
      <div class="row" id="s-days"></div>
      <div class="row"><button id="s-save">Save</button><span class="status" id="s-status"></span></div>
    </div>
  </section>
</main>
<script>
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var api = function (path, init) {
    init = init || {};
    init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {});
    return fetch('/admin/api' + path, init).then(function (r) {
      if (r.status === 401) { show(false); throw new Error('unauthorized'); }
      return r.status === 204 ? null : r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.status); return b; });
    });
  };
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var view = new Date(); view.setDate(1);
  var selected = null, cache = {};

  function show(authed) { $('#login').hidden = authed; $('#app').hidden = !authed; }
  function ymd(y, m, d) { return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }

  function loadMonth() {
    var y = view.getFullYear(), m = view.getMonth();
    var last = new Date(y, m + 1, 0).getDate();
    $('#month-label').textContent = view.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return api('/month?from=' + ymd(y, m, 1) + '&to=' + ymd(y, m, last)).then(function (res) {
      cache = {}; res.days.forEach(function (d) { cache[d.date] = d; });
      var g = $('#grid'); g.innerHTML = '';
      DAYS.forEach(function (n) { var h = document.createElement('div'); h.className = 'h'; h.textContent = n; g.appendChild(h); });
      var first = new Date(y, m, 1).getDay();
      for (var i = 0; i < first; i++) g.appendChild(document.createElement('div'));
      res.days.forEach(function (d) {
        var el = document.createElement('div');
        el.className = 'day' + (!d.open && !d.closed ? ' off' : '') + (d.closed ? ' closed' : '') + (d.open && d.remaining === 0 ? ' full' : '') + (d.date === selected ? ' sel' : '');
        el.innerHTML = '<b></b><span></span>';
        el.querySelector('b').textContent = Number(d.date.slice(8));
        el.querySelector('span').textContent = (d.open || d.used ? d.used + '/' + d.cap : '') + (d.subscriptionCount ? ' +' + d.subscriptionCount : '');
        el.addEventListener('click', function () { selected = d.date; loadMonth(); loadDay(); });
        g.appendChild(el);
      });
    });
  }

  function loadDay() {
    var d = cache[selected]; if (!d) return;
    $('#day-panel').hidden = false; $('#settings-panel').hidden = true;
    $('#day-title').textContent = new Date(selected + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    $('#day-cap').value = d.overrideCap === null ? '' : d.overrideCap;
    $('#day-cap').placeholder = 'default';
    $('#day-toggle').textContent = d.closed ? 'Reopen this day' : 'Close this day';
    api('/orders?date=' + selected).then(function (res) {
      var box = $('#orders'); box.innerHTML = '';
      if (!res.orders.length) { box.innerHTML = '<p class="status">No orders.</p>'; return; }
      res.orders.forEach(function (o) {
        if (o.status === 'cancelled') return;
        var el = document.createElement('div'); el.className = 'order';
        el.innerHTML = '<div><strong></strong> · <span class="size"></span> · <span class="st"></span></div><small class="contact"></small><div class="note"></div><div class="row"></div>';
        el.querySelector('strong').textContent = o.customerName;
        el.querySelector('.size').textContent = o.sizeId + (o.source === 'subscription' ? ' (subscription)' : '');
        el.querySelector('.st').textContent = o.status;
        el.querySelector('.contact').textContent = o.customerEmail + (o.customerPhone ? ' · ' + o.customerPhone : '');
        el.querySelector('.note').textContent = o.note || '';
        var row = el.querySelector('.row');
        if (o.status === 'paid' || o.status === 'done') {
          var b = document.createElement('button');
          b.textContent = o.status === 'paid' ? 'Mark done' : 'Undo done';
          b.addEventListener('click', function () { api('/orders/' + o.id + (o.status === 'paid' ? '/done' : '/undone'), { method: 'POST' }).then(loadDay); });
          row.appendChild(b);
        }
        box.appendChild(el);
      });
    });
  }

  function loadSettings() {
    $('#settings-panel').hidden = false; $('#day-panel').hidden = true;
    api('/settings').then(function (s) {
      $('#s-cap').value = s.cap; $('#s-cutoff').value = s.cutoff;
      var box = $('#s-days'); box.innerHTML = '';
      DAYS.forEach(function (n, i) {
        var l = document.createElement('label');
        l.innerHTML = '<input type="checkbox"> ' + n;
        l.querySelector('input').checked = s.openWeekdays.indexOf(i) >= 0;
        l.querySelector('input').value = i;
        box.appendChild(l);
      });
    });
  }

  $('#login').addEventListener('submit', function (e) {
    e.preventDefault();
    $('#login-status').textContent = '…';
    fetch('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: new FormData(e.target).get('passcode') }) })
      .then(function (r) { if (r.status === 204) { show(true); loadMonth(); } else { $('#login-status').textContent = 'Wrong passcode.'; } });
  });
  $('#logout').addEventListener('click', function () { api('/logout', { method: 'POST' }).then(function () { show(false); }); });
  $('#prev').addEventListener('click', function () { view.setMonth(view.getMonth() - 1); loadMonth(); });
  $('#next').addEventListener('click', function () { view.setMonth(view.getMonth() + 1); loadMonth(); });
  $('#settings-btn').addEventListener('click', loadSettings);
  $('#day-cap-save').addEventListener('click', function () {
    var v = $('#day-cap').value;
    api('/days/' + selected, { method: 'PUT', body: JSON.stringify({ cap: v === '' ? null : Number(v) }) }).then(loadMonth).then(loadDay);
  });
  $('#day-cap-clear').addEventListener('click', function () {
    api('/days/' + selected, { method: 'DELETE' }).then(loadMonth).then(loadDay);
  });
  $('#day-toggle').addEventListener('click', function () {
    api('/days/' + selected, { method: 'PUT', body: JSON.stringify({ closed: !cache[selected].closed }) }).then(loadMonth).then(loadDay);
  });
  $('#s-save').addEventListener('click', function () {
    var days = Array.prototype.map.call(document.querySelectorAll('#s-days input:checked'), function (i) { return Number(i.value); });
    api('/settings', { method: 'PUT', body: JSON.stringify({ cap: Number($('#s-cap').value), cutoff: $('#s-cutoff').value, openWeekdays: days }) })
      .then(function () { $('#s-status').textContent = 'Saved.'; loadMonth(); })
      .catch(function (e) { $('#s-status').textContent = e.message; });
  });

  api('/settings').then(function () { show(true); loadMonth(); }).catch(function () { show(false); });
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Manual verification**

`npm run dev`, open http://localhost:8787/admin. Sign in with the `.dev.vars` passcode. Confirm: month grid renders with counts; clicking a day shows the panel; "Close this day" turns the cell pink and the storefront's day picker (reload the home page) no longer offers it; saving a cap changes the "x/cap" text; Settings saves and the grid re-renders; Sign out returns to the passcode form.

- [ ] **Step 3: Commit**

```bash
git add site/admin/index.html
git commit -m "feat(site): admin page — month grid, close days, caps, orders, settings"
```

---

### Task 15: First deploy to a preview URL and Stripe test-mode end to end

**Files:**
- Modify: `wrangler.toml` (real `database_id`), `README.md` (deploy notes)

This task is mostly commands. It does not touch DNS: the site keeps serving from GitHub Pages until cutover, which happens after Plan 2 (emails and calendar) so that Anthony's first real order reaches him.

- [ ] **Step 1: Create the D1 database and record its id**

```bash
npx wrangler login
npx wrangler d1 create bullandbloom
```

Paste the printed `database_id` into `wrangler.toml`.

- [ ] **Step 2: Apply migrations remotely and set secrets**

```bash
npx wrangler d1 migrations apply bullandbloom --remote
npx wrangler secret put STRIPE_SECRET_KEY      # test-mode key for now
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # from step 4
npx wrangler secret put ADMIN_PASSCODE
npx wrangler secret put ADMIN_SECRET           # openssl rand -hex 32
```

- [ ] **Step 3: Deploy**

```bash
npm run deploy
```

Note the `*.workers.dev` URL. Temporarily set `SITE_URL` to it via `[vars]` in `wrangler.toml` on this branch only, redeploy, and revert before merge; success and cancel URLs must point at the preview during testing.

- [ ] **Step 4: Register the webhook in Stripe test mode**

Stripe Dashboard → Developers → Webhooks → Add endpoint: `https://<worker>.workers.dev/webhooks/stripe`, events `checkout.session.completed` and `checkout.session.expired`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` (Step 2) and redeploy.

- [ ] **Step 5: Acceptance walk-through (spec §4.6 subset)**

1. Buy a pickup bouquet with `4242 4242 4242 4242`; land on `/thanks`; admin shows it `paid`.
2. Start a checkout and abandon it; after 30 minutes admin shows it gone (or run the cron early with `npx wrangler dev --test-scheduled` locally and `curl "http://localhost:8787/__scheduled"`).
3. Close today in admin; the storefront no longer offers today.
4. Set a day's cap to 1, buy once, confirm the second attempt says "That day just filled up."
5. Try at or after the cutoff (or set the cutoff to a minute ago in Settings) and confirm today disappears from the picker.

- [ ] **Step 6: Record and commit**

Append to README:

```markdown
## Deploy

`npm run deploy` publishes the Worker and `site/`. Secrets live in Cloudflare (`wrangler secret put`), never in the repo.
Migrations: `npx wrangler d1 migrations apply bullandbloom --remote`. Stripe webhook endpoint: `/webhooks/stripe`.
```

```bash
git add wrangler.toml README.md
git commit -m "chore(store): production D1 id and deploy notes"
```

Then fill spec §8 Verification with what actually passed in Step 5, and note in spec §9 that Plan 1 is deployed to a preview URL pending Plans 2–3 and DNS cutover.

---

## Self-review

**Spec coverage for Plan 1's scope.** Storefront menu and date picker: Task 13. Daily pool, same-day cutoff, open weekdays, per-day overrides: Tasks 4, 5, 6. Blackouts from admin: Tasks 5, 12, 14 (calendar source is Plan 2; the merge logic in `getOverrides` already honours it). Hold on checkout, release on expiry: Tasks 5, 8, 9, 10. Stripe Checkout and webhook: Tasks 7–9. Admin grid, close, cap, orders, done: Tasks 12, 14. Settings in D1 overriding repo defaults: Tasks 2, 5, 12. D14 exclusion of subscription orders: Task 5 `USED` query and `countUsed`, tested. Failure modes for Stripe down (503, hold released) and lost webhook (cron expiry): Tasks 8, 10. Not in this plan, by design: carousel, subscriptions, delivery, Google calendar and email, DNS cutover.

**Placeholders.** `database_id` in Task 1 and SAMPLE values in `store.config.json` are deliberate and named as such in the spec's §7 blanks list. No "TBD" or "similar to Task N" anywhere.

**Type consistency.** `Defaults`/`Override`/`Clock`/`Availability` defined once in Task 4 and imported by Tasks 5, 6, 12. `Payments`/`CheckoutInput`/`WebhookEvent` defined in Task 6 stub, implemented in Task 7, consumed in Tasks 8, 9. `NewOrder`/`Order` from Task 5 used in Tasks 8, 12. `testApp` returns `{ app, payments, fetch }` and is used that way in Tasks 6, 8, 9, 12. `humanDate` is defined in Task 8 and produces the exact line-item string the test asserts (`Wed Sep 9` for 2026-09-09).
