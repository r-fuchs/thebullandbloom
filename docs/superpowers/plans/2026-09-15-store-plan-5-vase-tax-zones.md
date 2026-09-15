# Store Plan 5 — vase choice, Stripe Tax, delivery zones, Uber back on: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers choose hand-tied or in-a-vase, Stripe collects New York sales tax and accepts promotion codes, delivery falls back to per-region zone fees when Uber will not take an address, and Uber pricing is back on with a token cache that cannot serve a stale key.

**Architecture:** Repo config (`store.config.json`) stays the catalog. The vase choice is a per-size fee that becomes a second Stripe line item and two new columns on `orders`. Zones replace the flat zip list inside `delivery`. Tax is added by Stripe Checkout itself: every session turns on automatic tax and carries a tax code per line, and a Stripe Customer created per one-time order carries the delivery (or studio) address as the tax location. The Uber adapter ignores a cached token minted by a different client id.

**Tech Stack:** Cloudflare Worker (Hono, D1), Stripe Node SDK v22, vitest with `@cloudflare/vitest-pool-workers` (migrations in `migrations/` are applied to the test D1 automatically), ES5 storefront with no build step.

**Spec:** `docs/superpowers/specs/2026-09-15-store-plan-5-vase-tax-zones-design.md`

## Global Constraints

- Storefront JS (`site/store.js`, `site/admin/index.html`) is ES5: `var`, `function`, no arrow functions, no template literals, no `const`.
- Run all tests with `npx vitest run` (from the repo root; each test file shares one D1). Typecheck with `npx tsc --noEmit`. Both must be clean before every commit.
- Commit messages: conventional `type(scope): summary`, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Prices are integers in cents. Vase fees: Posy 1500, Bouquet 2000, Statement 2500. Zone fees: Capital District 1000, Saratoga 3500, Hudson 3500.
- Tax codes: flowers and vase `txcd_99999999`; delivery `txcd_92010001`. Tax behavior `exclusive` everywhere.
- Tests read the real repo config through `loadConfig()`; never hard-code a zip or fee that the config owns — read it from the config.
- Working in a worktree: `node_modules` is not there. Run `ln -s "$(git rev-parse --show-toplevel | sed 's#/.worktrees/.*##')/node_modules" node_modules` if the main checkout is the parent, otherwise `npm ci`.

## Task map and parallelism

| Task | Touches | Can run in parallel with |
|---|---|---|
| 1 Uber token cache bound to client id | `src/store/uber.ts`, `src/adapters/uber-api.ts` + tests | 2, 3, 5 |
| 2 Delivery zones | `src/config.ts` (delivery), `src/core/delivery.ts`, `src/routes/public.ts` (quote), `src/routes/admin-delivery.ts` (status), `site/admin/index.html` (delivery panel), `site/store.js` (quote note), `store.config.json` (delivery), README | 1, 3, 5 |
| 3 Vase choice | `src/config.ts` (sizes), `src/store/orders.ts`, `migrations/0006_vase.sql`, `src/routes/public.ts` (checkout), `src/core/messages.ts`, `src/core/delivery.ts` (item name), `src/routes/admin-delivery.ts` (dispatch), `site/admin/index.html` (orders), `site/index.html`, `site/store.js`, `store.config.json` (sizes) | 1, 2, 5 |
| 4 Stripe Tax + promotion codes | `src/adapters/payments.ts`, `src/adapters/stripe.ts`, `src/routes/public.ts` (line items), `src/routes/webhooks.ts`, `src/store/orders.ts`, `migrations/0007_tax.sql`, `src/core/messages.ts` | **after 3 is merged** |
| 5 Day grid accessibility | `site/store.js` (renderDays), `site/index.html` | 1, 2, 3 |

Tasks 2 and 3 both edit `src/config.ts`, `src/routes/public.ts`, `store.config.json`, `site/store.js` and `site/admin/index.html`, in different regions. Merge Task 2 first, then rebase Task 3 on it; conflicts, if any, are single hunks.

---

### Task 1: Uber token cache bound to the client id that minted it

**Files:**
- Modify: `src/store/uber.ts`
- Modify: `src/adapters/uber-api.ts:121-148`
- Test: `tests/store/uber.test.ts`, `tests/adapters/uber-api.test.ts`

**Interfaces:**
- Produces: `CachedToken { token: string; expiresAt: number; clientId?: string }` (optional so a pre-existing row still parses; the adapter treats a missing or different `clientId` as a miss).

- [ ] **Step 1: Write the failing tests**

In `tests/adapters/uber-api.test.ts`, after the test "reuses a cached token that is still fresh and never calls the auth endpoint", change that test's cache to carry the matching client id and add two tests:

```ts
  it("reuses a cached token that is still fresh and never calls the auth endpoint", async () => {
    const cache = memoryCache({ token: "at_cached", expiresAt: Math.floor(Date.now() / 1000) + 86400, clientId: "cid" });
    const { uber, calls } = api([{ status: 200, body: { id: "dqt_1", expires: "2026-09-09T19:15:37.887Z", fee: 600, currency: "usd" } }], cache);
    await uber.quote(QUOTE_REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.uber.com/v1/customers/cus_1/delivery_quotes");
    expect(calls[0].headers.authorization).toBe("Bearer at_cached");
  });

  it("ignores a fresh cached token minted by a different client id and re-mints (D38)", async () => {
    const cache = memoryCache({ token: "at_sandbox", expiresAt: Math.floor(Date.now() / 1000) + 86400, clientId: "other-app" });
    const { uber, calls } = api([TOKEN, { status: 200, body: { id: "dqt_2", expires: "2026-09-09T19:15:37.887Z", fee: 600, currency: "usd" } }], cache);
    await uber.quote(QUOTE_REQ);
    expect(calls[0].url).toBe("https://auth.uber.com/oauth/v2/token");
    expect(calls[1].headers.authorization).toBe("Bearer at_1");
    expect(cache.value).toMatchObject({ token: "at_1", clientId: "cid" });
  });

  it("treats a cached token with no client id (a row from before D38) as a miss", async () => {
    const cache = memoryCache({ token: "at_legacy", expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    const { uber, calls } = api([TOKEN, { status: 200, body: { id: "dqt_3", expires: "2026-09-09T19:15:37.887Z", fee: 600, currency: "usd" } }], cache);
    await uber.quote(QUOTE_REQ);
    expect(calls[0].url).toBe("https://auth.uber.com/oauth/v2/token");
    expect(cache.value?.clientId).toBe("cid");
  });
```

In `tests/store/uber.test.ts` replace the round-trip test:

```ts
  it("round-trips a token, its expiry and the client id that minted it", async () => {
    const c = tokenCache(env.DB);
    await c.save({ token: "at_1", expiresAt: 1_800_000_000, clientId: "cid_a" });
    expect(await c.load()).toEqual({ token: "at_1", expiresAt: 1_800_000_000, clientId: "cid_a" });
    await c.save({ token: "at_2", expiresAt: 1_900_000_000, clientId: "cid_b" });
    expect(await c.load()).toEqual({ token: "at_2", expiresAt: 1_900_000_000, clientId: "cid_b" });
  });

  it("still loads a row saved before the client id existed", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('uber.token', ?)")
      .bind(JSON.stringify({ token: "at_old", expiresAt: 1_800_000_000 })).run();
    expect(await tokenCache(env.DB).load()).toEqual({ token: "at_old", expiresAt: 1_800_000_000 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/adapters/uber-api.test.ts tests/store/uber.test.ts`
Expected: the two new adapter tests fail (`calls[0].url` is the quotes URL, not the auth URL); the store tests fail on the missing `clientId` (TypeScript error or `toEqual` mismatch).

- [ ] **Step 3: Implement**

`src/store/uber.ts`: change the interface and the `load` guard:

```ts
export interface CachedToken { token: string; expiresAt: number; clientId?: string } // expiresAt: unix seconds
```
and in `load()`:
```ts
        const v = JSON.parse(r.value_json) as CachedToken;
        if (typeof v?.token !== "string" || typeof v?.expiresAt !== "number") return null;
        return typeof v.clientId === "string" ? { token: v.token, expiresAt: v.expiresAt, clientId: v.clientId } : { token: v.token, expiresAt: v.expiresAt };
```

`src/adapters/uber-api.ts` in `accessToken()`:
```ts
    if (!force) {
      const hit = await this.cache.load();
      // D38: a token minted by another app (the sandbox keys before cutover) is never reused.
      if (hit && hit.clientId === this.clientId && hit.expiresAt - TOKEN_SKEW_SECONDS > nowSec) return hit.token;
    }
```
and the save:
```ts
    await this.cache.save({ token: t.access_token, expiresAt: nowSec + lifetime, clientId: this.clientId! });
```
Update the doc comment at the top of `src/store/uber.ts`: append "The row also records the client id that minted the token; the adapter ignores a row from any other client id (D38)."

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/adapters/uber-api.test.ts tests/store/uber.test.ts && npx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/uber.ts src/adapters/uber-api.ts tests/store/uber.test.ts tests/adapters/uber-api.test.ts
git commit -m "fix(uber): token cache is bound to the client id that minted it (D38)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Delivery zones replace the flat zip list; Uber mode back on

**Files:**
- Modify: `src/config.ts:24-25, 48-51`
- Modify: `src/core/delivery.ts:67-70`
- Modify: `src/routes/public.ts:13, 32-56`
- Modify: `src/routes/admin-delivery.ts:15-21`
- Modify: `site/admin/index.html:433-440`
- Modify: `site/store.js:125-129`
- Modify: `store.config.json` (`delivery` block)
- Modify: `README.md:8`
- Test: `tests/config.test.ts`, `tests/core/delivery.test.ts`, `tests/routes/public.test.ts`, `tests/routes/admin-delivery.test.ts`

**Interfaces:**
- Produces: `DeliveryZone { name: string; feeCents: number; zips: string[] }` in `src/config.ts`; `StoreConfig.delivery: { mode?: "uber" | "flat"; zones: DeliveryZone[] }`; `zoneFor(cfg, zip): DeliveryZone | null` and `fallbackFeeFor(cfg, zip): number | null` in `src/core/delivery.ts`; `/api/quote` fallback body gains `zone: string`; `/admin/api/delivery/status` returns `{ configured, mode, zones, variance }`.

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts`: replace the four delivery-related tests ("loads the studio ready time…" keeps everything but its last two lines; "rejects a bad delivery fallback"; "accepts delivery.mode…"; "accepts an empty fallback zip list…") with:

```ts
  it("loads the studio ready time, phone, structured address, and delivery zones", () => {
    const cfg = loadConfig();
    expect(cfg.studio.readyTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(cfg.studio.phone).toMatch(/^\+1\d{10}$/);
    expect(cfg.studio.address.state).toHaveLength(2);
    expect(cfg.studio.address.zip).toMatch(/^\d{5}$/);
    expect(cfg.delivery.zones.length).toBeGreaterThan(0);
    for (const z of cfg.delivery.zones) {
      expect(z.name).not.toBe("");
      expect(Number.isInteger(z.feeCents)).toBe(true);
      expect(z.zips.length).toBeGreaterThan(0);
    }
  });
  it("rejects a bad delivery zone", () => {
    const base = loadConfig();
    const zone = (over: Record<string, unknown>) => ({ ...base, delivery: { ...base.delivery, zones: [{ name: "Near", feeCents: 1000, zips: ["12203"], ...over }] } });
    expect(() => validateConfig(zone({ name: "" }))).toThrow(/zone needs a name/);
    expect(() => validateConfig(zone({ feeCents: -1 }))).toThrow(/feeCents/);
    expect(() => validateConfig(zone({ feeCents: 10.5 }))).toThrow(/feeCents/);
    expect(() => validateConfig(zone({ zips: ["1253"] }))).toThrow(/zips/);
    expect(() => validateConfig({ ...base, delivery: { ...base.delivery, zones: "nope" as any } })).toThrow(/delivery.zones/);
  });
  it("rejects a zip that appears in two zones", () => {
    const base = loadConfig();
    const zones = [{ name: "A", feeCents: 1000, zips: ["12203", "12204"] }, { name: "B", feeCents: 3500, zips: ["12866", "12204"] }];
    expect(() => validateConfig({ ...base, delivery: { ...base.delivery, zones } })).toThrow(/12204 is in two delivery zones/);
  });
  it("accepts delivery.mode uber, flat or absent, and rejects anything else", () => {
    const base = loadConfig();
    const d = base.delivery;
    expect(validateConfig({ ...base, delivery: { ...d, mode: "flat" } }).delivery.mode).toBe("flat");
    expect(validateConfig({ ...base, delivery: { ...d, mode: "uber" } }).delivery.mode).toBe("uber");
    const { mode: _m, ...noMode } = d;
    expect(validateConfig({ ...base, delivery: noMode }).delivery.mode).toBeUndefined();
    expect(() => validateConfig({ ...base, delivery: { ...d, mode: "sometimes" as any } })).toThrow(/delivery.mode/);
  });
  it("accepts an empty zone list (no fallback offered)", () => {
    const base = loadConfig();
    expect(validateConfig({ ...base, delivery: { ...base.delivery, zones: [] } }).delivery.zones).toEqual([]);
  });
```

`tests/core/delivery.test.ts`: replace the `fallbackFeeFor` describe with:

```ts
describe("zoneFor / fallbackFeeFor", () => {
  it("finds the zone a zip belongs to and its fee", () => {
    const first = cfg.delivery.zones[0], last = cfg.delivery.zones[cfg.delivery.zones.length - 1];
    expect(zoneFor(cfg, first.zips[0])?.name).toBe(first.name);
    expect(fallbackFeeFor(cfg, first.zips[0])).toBe(first.feeCents);
    expect(fallbackFeeFor(cfg, last.zips[last.zips.length - 1])).toBe(last.feeCents);
    expect(zoneFor(cfg, "99999")).toBeNull();
    expect(fallbackFeeFor(cfg, "99999")).toBeNull();
  });
  it("returns null for every zip when there are no zones", () => {
    expect(fallbackFeeFor({ ...cfg, delivery: { ...cfg.delivery, zones: [] } }, "12534")).toBeNull();
  });
});
```
and add `zoneFor` to the import from `../../src/core/delivery`.

`tests/routes/public.test.ts`: replace line 127 and the fee assertion:

```ts
const ZONE = loadConfig().delivery.zones[0];
const FAR_ZONE = loadConfig().delivery.zones[loadConfig().delivery.zones.length - 1];
const LISTED_ZIP = ZONE.zips[0];
```
In "offers the flat fallback fee for a listed zip when Uber says the address is undeliverable":
```ts
    expect(body).toMatchObject({ available: true, kind: "fallback", estimate: false, zone: ZONE.name });
    expect(body.feeCents).toBe(ZONE.feeCents);
```
Add after it:
```ts
  it("prices a zip in the last zone at that zone's fee when Uber refuses", async () => {
    const { fetch, uber } = testApp();
    uber.failWith("undeliverable", "too far");
    const far = { ...address, city: "Hudson", zip: FAR_ZONE.zips[0] };
    const body = await (await quoteFor(fetch, { date: "2026-09-16", address: far })).json() as any;
    expect(body).toMatchObject({ available: true, kind: "fallback", feeCents: FAR_ZONE.feeCents, zone: FAR_ZONE.name });
  });
```

`tests/routes/admin-delivery.test.ts`: in the first status test replace the two fallback assertions with `expect(Array.isArray(body.zones)).toBe(true);` and rewrite the last describe:

```ts
describe("GET /admin/api/delivery/status", () => {
  it("reports the delivery mode and the zones", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    const body = await (await as("/admin/api/delivery/status")).json() as any;
    const cfg = loadConfig();
    expect(body).toMatchObject({ mode: cfg.delivery.mode ?? "uber", zones: cfg.delivery.zones });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/core/delivery.test.ts tests/routes/public.test.ts tests/routes/admin-delivery.test.ts`
Expected: failures on `zones` being undefined and `zoneFor` not exported.

- [ ] **Step 3: Config shape and validation**

`src/config.ts`: replace the `delivery` line of `StoreConfig` and its doc comment:

```ts
export interface DeliveryZone { name: string; feeCents: number; zips: string[] }
```
(above `StoreConfig`), and inside `StoreConfig`:
```ts
  /**
   * Delivery pricing (spec Plan 5 D35/D36). `mode` "uber" (default): Uber prices each address and
   * a zone fee covers listed zips Uber will not serve. `mode` "flat": Uber is never called and
   * every listed zip gets its zone fee. A zip in no zone is outside the delivery area. Empty
   * zones = no fallback.
   */
  delivery: { mode?: "uber" | "flat"; zones: DeliveryZone[] };
```
Replace the two `d.fallback…` validation lines with:
```ts
  const d = cfg.delivery;
  if (!d || !Array.isArray(d.zones)) throw new Error("config: delivery.zones must be an array");
  const seenZips = new Set<string>();
  for (const z of d.zones) {
    if (typeof z?.name !== "string" || z.name.trim() === "") throw new Error("config: every delivery zone needs a name");
    if (!Number.isInteger(z.feeCents) || z.feeCents < 0) throw new Error(`config: delivery zone ${z.name} feeCents must be a non-negative integer`);
    if (!Array.isArray(z.zips) || !z.zips.every((x) => ZIP.test(x))) throw new Error(`config: delivery zone ${z.name} zips must be five-digit zips`);
    for (const x of z.zips) {
      if (seenZips.has(x)) throw new Error(`config: zip ${x} is in two delivery zones`);
      seenZips.add(x);
    }
  }
```
(keep the existing `d.mode` check after it).

- [ ] **Step 4: Core lookup**

`src/core/delivery.ts`: add `DeliveryZone` to the type import from `../config` and replace `fallbackFeeFor`:

```ts
/** The zone a zip belongs to, or null when it is outside the delivery area (spec Plan 5 D35). */
export function zoneFor(cfg: StoreConfig, zip: string): DeliveryZone | null {
  return cfg.delivery.zones.find((z) => z.zips.includes(zip)) ?? null;
}

/** The zone fee for a zip, or null when no zone lists it. */
export function fallbackFeeFor(cfg: StoreConfig, zip: string): number | null {
  return zoneFor(cfg, zip)?.feeCents ?? null;
}
```

- [ ] **Step 5: Routes, admin, storefront, config file, README**

`src/routes/public.ts`: import `zoneFor` (replace `fallbackFeeFor` in the import). `deliveryOffered`:
```ts
function deliveryOffered(uberConfigured: boolean, cfg: { delivery: { zones: DeliveryZone[] } }): boolean {
  return uberConfigured || cfg.delivery.zones.some((z) => z.zips.length > 0);
}
```
(import `DeliveryZone` type from `../config`). `fallbackResponse` body:
```ts
  const zone = zoneFor(config, zip);
  if (!zone) return c.json({ available: false, reason: noFallbackReason });
  return c.json({
    available: true, feeCents: zone.feeCents, kind: "fallback" as const, zone: zone.name,
    // A flat zone fee is never an estimate — it does not depend on when the courier can go.
    estimate: false,
    quoteToken: await signQuote(secret, {
      feeCents: zone.feeCents, quoteId: null, kind: "fallback", date, addr, exp: nowSec + FALLBACK_TTL_SECONDS,
    }),
  });
```

`src/routes/admin-delivery.ts` status handler: replace `fallbackFeeCents` and `fallbackZips` with `zones: config.delivery.zones,`.

`site/admin/index.html` in `loadDelivery`: add above the `api(...)` call
```js
    function zoneSummary(zones) {
      if (!zones || !zones.length) return '(no zones set)';
      return zones.map(function (z) { return z.name + ' ' + money(z.feeCents) + ' (' + z.zips.length + ' ZIPs)'; }).join(' · ');
    }
```
and replace the `#d-summary` assignment:
```js
      $('#d-summary').textContent = s.mode === 'flat'
        ? 'Uber is switched off. Delivery is priced by zone — ' + zoneSummary(s.zones) + ' — and you deliver every order yourself.'
        : s.configured
        ? 'Uber prices each address. Where Uber will not go, the zone fee applies — ' + zoneSummary(s.zones) + ' — and you deliver those yourself.'
        : 'Uber is not set up yet. Delivery is priced by zone — ' + zoneSummary(s.zones) + ' — and you deliver every order yourself.';
```

`site/store.js` quote note (inside the `r.ok && r.body.available` branch):
```js
          quoteNote.textContent = 'Delivery ' + money(r.body.feeCents) +
            (r.body.zone ? ' (' + r.body.zone + ')' : '') +
            (r.body.estimate === true ? ' (estimated — priced as of today)' : '') +
            (r.body.kind === 'fallback' ? ' — Anthony delivers this one himself.' : '');
```

`store.config.json` `delivery` block becomes exactly:
```json
  "delivery": {
    "mode": "uber",
    "zones": [
      { "name": "Capital District", "feeCents": 1000, "zips": [
        "12202", "12203", "12204", "12205", "12206", "12207", "12208", "12209", "12210", "12211", "12222",
        "12110", "12009", "12047", "12054", "12061", "12065", "12077", "12084", "12144", "12158", "12159",
        "12180", "12182", "12183", "12186", "12189", "12198",
        "12302", "12303", "12304", "12305", "12306", "12307", "12308", "12309" ] },
      { "name": "Saratoga", "feeCents": 3500, "zips": [
        "12866", "12020", "12019", "12027", "12074", "12118", "12148", "12151", "12170", "12188",
        "12803", "12822", "12831", "12833", "12850", "12859", "12863", "12871", "12884" ] },
      { "name": "Hudson", "feeCents": 3500, "zips": [
        "12534", "12513", "12172", "12106", "12184", "12037", "12075", "12565", "12173", "12541",
        "12526", "12544", "12530", "12521", "12529", "12516", "12130", "12050",
        "12033", "12123", "12156", "12143", "12045", "12051", "12015", "12414" ] }
    ]
  }
```

`README.md` line 8: replace "delivery fallback fee and ZIPs" with "delivery zones (name, fee, ZIPs) and mode".

- [ ] **Step 6: Run everything and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green. If `tests/smoke.test.ts` or another file mentions `fallbackZips`, fix it to read `zones`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(delivery): zones with their own fees replace the flat zip list; Uber mode back on (D35, D36)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Hand-tied or arranged in a vase

**Files:**
- Modify: `src/config.ts:3, 55-58`
- Modify: `store.config.json` (`sizes`)
- Create: `migrations/0006_vase.sql`
- Modify: `src/store/orders.ts`
- Modify: `src/routes/public.ts:58-94, 255-271`
- Modify: `src/core/messages.ts`
- Modify: `src/core/delivery.ts:72-75`
- Modify: `src/routes/admin-delivery.ts:60-70`
- Modify: `site/admin/index.html:207`
- Modify: `site/index.html:229-234`, `site/store.js`
- Test: `tests/config.test.ts`, `tests/store/orders.test.ts`, `tests/routes/public.test.ts`, `tests/core/messages.test.ts`, `tests/core/delivery.test.ts`, `tests/routes/admin-delivery.test.ts`

**Interfaces:**
- Produces: `Size.vaseFeeCents: number`; `type Presentation = "hand-tied" | "vase"` exported from `src/store/orders.ts`; `Order` and `NewOrder` gain `presentation: Presentation; vaseCents: number`; `/api/checkout` accepts `presentation`; `deliveryItemName(sizeName: string, presentation?: Presentation): string`; a Stripe line item named `Vase` between bouquet and delivery.

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts`, add:
```ts
  it("loads a vase fee per size and rejects a bad one", () => {
    const base = loadConfig();
    for (const s of base.sizes) expect(Number.isInteger(s.vaseFeeCents) && s.vaseFeeCents >= 0).toBe(true);
    expect(() => validateConfig({ ...base, sizes: [{ ...base.sizes[0], vaseFeeCents: -5 }] })).toThrow(/vaseFeeCents/);
    expect(() => validateConfig({ ...base, sizes: [{ ...base.sizes[0], vaseFeeCents: 1.5 }] })).toThrow(/vaseFeeCents/);
  });
```

`tests/store/orders.test.ts`: `fresh()` gains `presentation: "hand-tied", vaseCents: 0,` and add:
```ts
  it("stores the presentation and vase cents", async () => {
    const o = { ...fresh("2026-09-27"), presentation: "vase" as const, vaseCents: 2000 };
    expect(await tryInsertHeldOrder(env.DB, o, 5, NOW, NOW + 1800)).toBe(true);
    const got = await getOrder(env.DB, o.id);
    expect(got).toMatchObject({ presentation: "vase", vaseCents: 2000 });
    const plain = await getOrder(env.DB, (await (async () => { const p = fresh("2026-09-27"); await tryInsertHeldOrder(env.DB, p, 5, NOW, NOW + 1800); return p; })()).id);
    expect(plain).toMatchObject({ presentation: "hand-tied", vaseCents: 0 });
  });
```

`tests/routes/public.test.ts`: in "returns sizes and timezone…" add `expect(body.sizes[0]).toHaveProperty("vaseFeeCents");`. Add a describe after "POST /api/checkout — delivery":
```ts
describe("POST /api/checkout — presentation", () => {
  const vaseFee = () => loadConfig().sizes.find((s) => s.id === "bouquet")!.vaseFeeCents;
  it("adds a Vase line item and stores the choice", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, { ...good, date: "2026-09-29", presentation: "vase" });
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems).toEqual([
      { name: "Bouquet — pickup Tue Sep 29", amountCents: 8500, quantity: 1 },
      { name: "Vase", amountCents: vaseFee(), quantity: 1 },
    ]);
    const row = await env.DB.prepare("SELECT presentation, vase_cents FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ presentation: "vase", vase_cents: vaseFee() });
  });
  it("defaults to hand-tied when the field is missing", async () => {
    const { fetch, payments } = testApp();
    expect((await post(fetch, { ...good, date: "2026-09-30" })).status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems.map((li) => li.name)).toEqual(["Bouquet — pickup Wed Sep 30"]);
    const row = await env.DB.prepare("SELECT presentation, vase_cents FROM orders WHERE id = ?").bind(c.orderId).first<any>();
    expect(row).toEqual({ presentation: "hand-tied", vase_cents: 0 });
  });
  it("rejects an unknown presentation", async () => {
    const { fetch } = testApp();
    const r = await post(fetch, { ...good, presentation: "bowl" });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/presentation/);
  });
  it("puts the Vase line between the bouquet and the delivery fee", async () => {
    const { fetch, payments } = testApp();
    const r = await post(fetch, await deliveryBody(fetch, { presentation: "vase" }));
    expect(r.status).toBe(200);
    const c = payments.created[payments.created.length - 1];
    expect(c.lineItems.map((li) => li.name)).toEqual(["Bouquet — delivery Wed Sep 23", "Vase", "Delivery — Wed Sep 23"]);
  });
});
```

`tests/core/messages.test.ts`: `order` fixture gains `presentation: "hand-tied", vaseCents: 0,` and add:
```ts
describe("vase orders", () => {
  const vased: Order = { ...order, presentation: "vase", vaseCents: 2000 };
  it("names the vase in the calendar event", () => {
    const ev = orderEvent(vased, cfg, SITE);
    expect(ev.summary).toBe("Bouquet · vase · Pat Smith · pickup");
    expect(ev.description.split("\n")[0]).toBe("Bouquet ($85.00) · vase ($20.00) · pickup");
  });
  it("tells the customer and shows the vase line and total", () => {
    const m = customerEmail(vased, cfg);
    expect(m.text).toContain("Thank you. Your Bouquet, arranged in a vase, is booked for pickup on Wednesday, September 9.");
    expect(m.text).toContain("  Bouquet: $85.00\n  Vase: $20.00\n  Total: $105.00");
  });
  it("tells Anthony in the subject", () => {
    expect(ownerEmail(vased, cfg, SITE).subject).toBe("New order: Bouquet in a vase · Pat Smith · Wed Sep 9 (pickup)");
  });
});
```

`tests/core/delivery.test.ts` `deliveryItemName` describe:
```ts
  it("names the parcel for the courier without revealing the customer", () => {
    expect(deliveryItemName("Bouquet")).toBe("Bouquet — hand-tied flowers");
    expect(deliveryItemName("Bouquet", "hand-tied")).toBe("Bouquet — hand-tied flowers");
    expect(deliveryItemName("Bouquet", "vase")).toBe("Bouquet — flowers in a vase");
  });
```

`tests/routes/admin-delivery.test.ts`: the `order()` helper's `over` type gains `presentation: string; vaseCents: number`, the defaults gain `presentation: "hand-tied", vaseCents: 0`, and the INSERT adds `presentation, vase_cents` columns bound after `delivery_cents`. Add to the dispatch describe:
```ts
  it("tells the courier it is a vase and declares the vase in the parcel value", async () => {
    await order("d7", { presentation: "vase", vaseCents: 2000 });
    const { fetch, uber } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/orders/d7/dispatch", { method: "POST" })).status).toBe(200);
    expect(uber.created[uber.created.length - 1].itemName).toBe("Bouquet — flowers in a vase");
    expect(uber.created[uber.created.length - 1].valueCents).toBe(10500);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/store/orders.test.ts tests/routes/public.test.ts tests/core/messages.test.ts tests/core/delivery.test.ts tests/routes/admin-delivery.test.ts`
Expected: type errors on `vaseFeeCents` / `presentation`, and assertion failures.

- [ ] **Step 3: Config and migration**

`src/config.ts`: `export interface Size { id: string; name: string; description: string; priceCents: number; vaseFeeCents: number }`. In the sizes loop add:
```ts
    if (!Number.isInteger(s.vaseFeeCents) || s.vaseFeeCents < 0) throw new Error(`config: size ${s.id} vaseFeeCents must be a non-negative integer`);
```
`store.config.json`: add `"vaseFeeCents": 1500` to posy, `2000` to bouquet, `2500` to statement.

`migrations/0006_vase.sql`:
```sql
-- Plan 5 (D34): hand-tied or arranged in a vase, and what the vase cost.
ALTER TABLE orders ADD COLUMN presentation TEXT NOT NULL DEFAULT 'hand-tied' CHECK (presentation IN ('hand-tied','vase'));
ALTER TABLE orders ADD COLUMN vase_cents INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Orders store**

`src/store/orders.ts`: add `export type Presentation = "hand-tied" | "vase";`. `Order` gains `presentation: Presentation; vaseCents: number;` after `deliveryCents`; `NewOrder` gains the same; `Row` gains `presentation: Presentation; vase_cents: number;`. `COLS` gains `presentation, vase_cents` after `delivery_cents`. `fromRow` maps `presentation: r.presentation, vaseCents: r.vase_cents`. `tryInsertHeldOrder`:
```ts
    `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, address_json, note, bouquet_cents, delivery_cents, uber_quote_id, source, hold_expires_at,
       presentation, vase_cents)
     SELECT ?2, ?3, 'held', ?1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'one_time', ?14, ?16, ?17
     WHERE (${USED}) < ?15`,
  ).bind(o.date, o.id, now, o.sizeId, o.fulfillment, o.customerName, o.customerEmail, o.customerPhone,
    o.addressJson, o.note, o.bouquetCents, o.deliveryCents, o.uberQuoteId, holdExpiresAt, cap, o.presentation, o.vaseCents).run();
```

- [ ] **Step 5: Checkout route**

`src/routes/public.ts`: import `type Presentation` from `../store/orders`. `CheckoutBody` gains `presentation: Presentation;`. In `parseCheckout`, after the fulfillment check:
```ts
  const presentation: Presentation = b.presentation === undefined ? "hand-tied" : b.presentation;
  if (presentation !== "hand-tied" && presentation !== "vase") return { ok: false, error: "presentation must be hand-tied or vase" };
```
and include `presentation` in the returned body. In the handler: `const vaseCents = body.presentation === "vase" ? size.vaseFeeCents : 0;`, pass `presentation: body.presentation, vaseCents` into `tryInsertHeldOrder`, and build line items:
```ts
    const lineItems = [
      { name: `${size.name} — ${body.fulfillment} ${humanDate(body.date)}`, amountCents: size.priceCents, quantity: 1 },
    ];
    if (vaseCents > 0) lineItems.push({ name: "Vase", amountCents: vaseCents, quantity: 1 });
    if (deliveryCents > 0) lineItems.push({ name: `Delivery — ${humanDate(body.date)}`, amountCents: deliveryCents, quantity: 1 });
```

- [ ] **Step 6: Messages, courier item name, admin**

`src/core/messages.ts`: add `const inVase = (o: Order) => o.presentation === "vase";`. In `orderEvent`: `summary: \`${size}${inVase(order) ? " · vase" : ""} · ${order.customerName} · ${order.fulfillment}${sub ? " (subscription)" : ""}\`` and the non-subscription description first line `\`${size} (${dollars(order.bouquetCents)})${inVase(order) ? \` · vase (${dollars(order.vaseCents)})\` : ""} · ${order.fulfillment}\``. In `customerEmail`: the thank-you line becomes `\`Thank you. Your ${size}${inVase(order) ? ", arranged in a vase," : ""} is booked for ${order.fulfillment} on ${longDate(order.date)}.\``; after the size line push `if (order.vaseCents > 0) lines.push(\`  Vase: ${dollars(order.vaseCents)}\`);`; replace the delivery/total block with:
```ts
  if (order.deliveryCents > 0) lines.push(`  Delivery: ${dollars(order.deliveryCents)}`);
  if (order.vaseCents > 0 || order.deliveryCents > 0) lines.push(`  Total: ${dollars(order.bouquetCents + order.vaseCents + order.deliveryCents)}`);
```
In `ownerEmail`: subject `\`New order: ${size}${inVase(order) ? " in a vase" : ""} · ${order.customerName} · ${humanDate(order.date)} (${order.fulfillment})\`` and the first text line `\`${size} (${dollars(order.bouquetCents)})${inVase(order) ? \` · vase (${dollars(order.vaseCents)})\` : ""} · ${order.fulfillment} · ${longDate(order.date)}\``.

`src/core/delivery.ts`: import `type Presentation` from `../store/orders` and
```ts
export function deliveryItemName(sizeName: string, presentation: Presentation = "hand-tied"): string {
  return presentation === "vase" ? `${sizeName} — flowers in a vase` : `${sizeName} — hand-tied flowers`;
}
```

`src/routes/admin-delivery.ts`: `const valueCents = order.bouquetCents + order.vaseCents;` before the quote; use `valueCents` in both `uber.quote({...})` and `uber.createDelivery({...})`; `itemName: deliveryItemName(sizeById(config, order.sizeId)?.name ?? order.sizeId, order.presentation)`.

`site/admin/index.html` line 207: `el.querySelector('.size').textContent = o.sizeId + (o.presentation === 'vase' ? ' · vase' : '') + (o.source === 'subscription' ? ' (subscription)' : '');`

- [ ] **Step 7: Storefront**

`site/index.html`, directly after the `#fulfillment-picker` fieldset (before `#delivery-fields`):
```html
      <fieldset class="full sizes" id="presentation-picker">
        <legend>How it comes</legend>
        <label><input type="radio" name="presentation" value="hand-tied" checked><span>Hand-tied and wrapped, no vase</span></label>
        <label><input type="radio" name="presentation" value="vase"><span id="vase-label">Arranged in a clear glass vase</span></label>
      </fieldset>
```

`site/store.js`:
- after `isDelivery`: 
```js
  function isVase() { return form.elements['presentation'] && form.elements['presentation'].value === 'vase'; }
  function sizeOf(id) { return cfgCache ? cfgCache.sizes.filter(function (x) { return x.id === id; })[0] : null; }
  function vaseCents() { var sz = sizeOf(state.sizeId); return sz && sz.vaseFeeCents ? sz.vaseFeeCents : 0; }
  function renderVaseLabel() { var el = $('#vase-label'); if (el) el.textContent = 'Arranged in a clear glass vase — +' + money(vaseCents()); }
```
- `chooseSize`: `state.sizeId = id; renderCardPrices(); renderVaseLabel(); refreshTotal();`; at the end of `renderSizes` (before `applyFulfillment()`) call `renderVaseLabel();`.
- `refreshTotal` becomes:
```js
  function refreshTotal() {
    var b = bouquetCents();
    var dayChosen = !!(new FormData(form)).get('date');
    if (!b || !dayChosen) { totalLine.textContent = ''; pay.disabled = true; return; }
    var parts = ['Bouquet ' + money(b)], total = b, v = vaseCents();
    if (isVase()) { parts.push('vase ' + money(v)); total += v; }
    if (isDelivery()) {
      if (!quote) { totalLine.textContent = ''; pay.disabled = true; return; }
      parts.push('delivery ' + money(quote.feeCents)); total += quote.feeCents;
    }
    totalLine.textContent = (parts.length > 1 ? parts.join(' + ') + ' = ' + money(total) : 'Total ' + money(total) + ' · pickup is free') + ' · tax added at checkout';
    pay.disabled = false;
  }
```
- change handler: add `if (n === 'presentation') { refreshTotal(); return; }` before the fulfillment line.
- submit body: add `presentation: isVase() ? 'vase' : 'hand-tied',` after `fulfillment`.

- [ ] **Step 8: Run everything and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green. Fixture inserts in `tests/routes/webhooks.test.ts` and `tests/store/subscribers.test.ts` rely on the column defaults and need no change.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(store): hand-tied or arranged in a vase, priced per size (D34)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Stripe Tax and promotion codes (after Task 3 is merged)

**Files:**
- Modify: `src/adapters/payments.ts`
- Modify: `src/adapters/stripe.ts`
- Modify: `src/routes/public.ts` (line items and `createCheckout` input)
- Modify: `src/routes/webhooks.ts:42-45`
- Modify: `src/store/orders.ts` (`markPaidBySession`, `Order`, `Row`, `COLS`)
- Create: `migrations/0007_tax.sql`
- Modify: `src/core/messages.ts` (`customerEmail`)
- Test: `tests/adapters/stripe.test.ts`, `tests/routes/webhooks.test.ts`, `tests/store/orders.test.ts`, `tests/routes/public.test.ts`, `tests/core/messages.test.ts`

**Interfaces:**
- Consumes: `Order.vaseCents`, the `Vase` line item from Task 3; `PostalAddress` from `src/config.ts`.
- Produces: `TaxCategory = "flowers" | "vase" | "delivery"`; `CheckoutLineItem.taxCategory`; `CheckoutInput.customerName: string` and `CheckoutInput.taxAddress: PostalAddress`; `checkoutParams(input, customerId)` and `subscriptionParams(input)` exported from `src/adapters/stripe.ts`; `WebhookEvent` completed gains `taxCents: number`; `markPaidBySession(db, sessionId, paymentIntent, taxCents, extra?)`; `Order.taxCents`.

- [ ] **Step 1: Write the failing tests**

`tests/adapters/stripe.test.ts`, add the import `checkoutParams, subscriptionParams` from `../../src/adapters/stripe` and:
```ts
describe("checkoutParams (Stripe Tax, D37; promotion codes, D40)", () => {
  const input = {
    orderId: "o1", customerEmail: "pat@example.com", customerName: "Pat Lee",
    taxAddress: { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" },
    lineItems: [
      { name: "Bouquet — delivery Wed Sep 23", amountCents: 8500, quantity: 1, taxCategory: "flowers" as const },
      { name: "Vase", amountCents: 2000, quantity: 1, taxCategory: "vase" as const },
      { name: "Delivery — Wed Sep 23", amountCents: 1200, quantity: 1, taxCategory: "delivery" as const },
    ],
    successUrl: "https://x/ok", cancelUrl: "https://x/no", expiresAt: 1_800_000_000,
  };
  it("turns on automatic tax, allows promotion codes, and prices every line tax-exclusive with a tax code", () => {
    const p = checkoutParams(input, "cus_1");
    expect(p.mode).toBe("payment");
    expect(p.customer).toBe("cus_1");
    expect(p.customer_email).toBeUndefined();
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.allow_promotion_codes).toBe(true);
    expect(p.customer_update).toEqual({ address: "auto" });
    expect(p.line_items!.map((li) => li.price_data!.tax_behavior)).toEqual(["exclusive", "exclusive", "exclusive"]);
    expect(p.line_items!.map((li) => li.price_data!.product_data!.tax_code)).toEqual(["txcd_99999999", "txcd_99999999", "txcd_92010001"]);
    expect(p.line_items![1].price_data!.unit_amount).toBe(2000);
    expect(p.metadata).toEqual({ order_id: "o1" });
    expect(p.expires_at).toBe(1_800_000_000);
  });
  it("subscription sessions get tax and promotion codes too", () => {
    const p = subscriptionParams({ customerEmail: "pat@example.com", productName: "Bouquet · every week", amountCents: 29000, metadata: { cell: "bouquet/weekly" }, successUrl: "https://x/ok", cancelUrl: "https://x/no" });
    expect(p.mode).toBe("subscription");
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.allow_promotion_codes).toBe(true);
    expect(p.line_items![0].price_data!.tax_behavior).toBe("exclusive");
    expect(p.line_items![0].price_data!.product_data!.tax_code).toBe("txcd_99999999");
  });
});
```
Update the two completed-session mapping tests to expect `taxCents`:
```ts
  it("maps completed sessions, with the tax Stripe collected", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_1", total_details: { amount_tax: 680 } } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_1", paymentIntent: "pi_1", taxCents: 680 });
  });
  it("tolerates an expanded payment_intent object and a session with no tax details", () => {
    expect(toWebhookEvent({ type: "checkout.session.completed", data: { object: { id: "cs_3", payment_intent: { id: "pi_3" } } } }))
      .toEqual({ type: "checkout.session.completed", sessionId: "cs_3", paymentIntent: "pi_3", taxCents: 0 });
  });
```

`tests/routes/webhooks.test.ts`: every `payments.nextEvent = { type: "checkout.session.completed", … }` gains `taxCents: 0` except the first test, which uses `taxCents: 680` and asserts:
```ts
    const row = await env.DB.prepare("SELECT status, stripe_payment_intent, hold_expires_at, tax_cents FROM orders WHERE id = 'w1'").first<any>();
    expect(row).toEqual({ status: "paid", stripe_payment_intent: "pi_w1", hold_expires_at: null, tax_cents: 680 });
```

`tests/store/orders.test.ts`: every `markPaidBySession(env.DB, "cs…", "pi…")` call gains a fourth argument `0` before any `extra` array, and one test asserts `taxCents`:
```ts
  it("records the tax Stripe collected when marking paid", async () => {
    const o = fresh("2026-09-28");
    await tryInsertHeldOrder(env.DB, o, 5, NOW, NOW + 1800);
    await attachSession(env.DB, o.id, "cs_tax");
    const paid = await markPaidBySession(env.DB, "cs_tax", "pi_tax", 680);
    expect(paid).toMatchObject({ status: "paid", taxCents: 680 });
  });
```

`tests/routes/public.test.ts`: every `lineItems` `toEqual` gains `taxCategory` (`"flowers"` on bouquet lines, `"vase"` on Vase, `"delivery"` on Delivery), and the delivery test also asserts the tax address:
```ts
    expect(c.customerName).toBe("Pat Lee");
    expect(c.taxAddress).toEqual({ street: "5 Elm Street", unit: "", city: "Albany", state: "NY", zip: LISTED_ZIP });
```
and the pickup test asserts `expect(c.taxAddress).toEqual(loadConfig().studio.address);`.

`tests/core/messages.test.ts`: `order` fixture gains `taxCents: 0`; add:
```ts
  it("shows sales tax and a total including it", () => {
    const m = customerEmail({ ...order, taxCents: 680 }, cfg);
    expect(m.text).toContain("  Bouquet: $85.00\n  Sales tax: $6.80\n  Total: $91.80");
  });
```
(inside the `customerEmail` describe).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/adapters/stripe.test.ts tests/routes/webhooks.test.ts tests/store/orders.test.ts tests/routes/public.test.ts tests/core/messages.test.ts`
Expected: `checkoutParams` not exported; `taxCents` missing; type errors on `taxCategory`.

- [ ] **Step 3: Payments interface**

`src/adapters/payments.ts`:
```ts
import type { PostalAddress } from "../config";

/** Which Stripe tax code a line carries (spec Plan 5 D37). */
export type TaxCategory = "flowers" | "vase" | "delivery";
export interface CheckoutLineItem { name: string; amountCents: number; quantity: number; taxCategory: TaxCategory }
export interface CheckoutInput {
  orderId: string; customerEmail: string; customerName: string;
  /** where the flowers go: the delivery address, or the studio for pickup. Stripe Tax's location. */
  taxAddress: PostalAddress;
  lineItems: CheckoutLineItem[];
  successUrl: string; cancelUrl: string; expiresAt: number; // unix seconds
}
```
and the completed event: `| { type: "checkout.session.completed"; sessionId: string; paymentIntent: string; taxCents: number }`.

- [ ] **Step 4: Stripe adapter**

`src/adapters/stripe.ts`:
```ts
import type { CheckoutInput, CheckoutSession, Payments, SubscriptionCheckoutInput, TaxCategory, WebhookEvent } from "./payments";

/** Stripe Tax codes. No floral-specific code exists; shipping lets Stripe apply NY's taxable-delivery rule. */
const TAX_CODES: Record<TaxCategory, string> = { flowers: "txcd_99999999", vase: "txcd_99999999", delivery: "txcd_92010001" };

export function checkoutParams(input: CheckoutInput, customerId: string): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    customer: customerId,
    customer_update: { address: "auto" },
    automatic_tax: { enabled: true },
    allow_promotion_codes: true,
    client_reference_id: input.orderId,
    metadata: { order_id: input.orderId },
    line_items: input.lineItems.map((li) => ({
      quantity: li.quantity,
      price_data: {
        currency: "usd", unit_amount: li.amountCents, tax_behavior: "exclusive",
        product_data: { name: li.name, tax_code: TAX_CODES[li.taxCategory] },
      },
    })),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: input.expiresAt,
  };
}

export function subscriptionParams(input: SubscriptionCheckoutInput): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    customer_email: input.customerEmail,
    automatic_tax: { enabled: true },
    allow_promotion_codes: true,
    metadata: input.metadata,
    subscription_data: { metadata: input.metadata },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd", unit_amount: input.amountCents, recurring: { interval: "month" }, tax_behavior: "exclusive",
        product_data: { name: input.productName, tax_code: TAX_CODES.flowers },
      },
    }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}
```
`createCheckout` becomes:
```ts
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const a = input.taxAddress;
    // One Customer per order carries the tax location (D37): Stripe Tax prefers the shipping address.
    const customer = await this.stripe.customers.create({
      email: input.customerEmail, name: input.customerName,
      shipping: { name: input.customerName, address: { line1: a.street, line2: a.unit || undefined, city: a.city, state: a.state, postal_code: a.zip, country: "US" } },
      metadata: { order_id: input.orderId },
    });
    const session = await this.stripe.checkout.sessions.create(checkoutParams(input, customer.id));
    if (!session.url) throw new Error("stripe: session has no url");
    return { id: session.id, url: session.url };
  }
```
`createSubscriptionCheckout` calls `this.stripe.checkout.sessions.create(subscriptionParams(input))`. In `toWebhookEvent`, the completed return becomes `{ type: "checkout.session.completed", sessionId: o.id, paymentIntent: idOf(o.payment_intent), taxCents: Number(o.total_details?.amount_tax ?? 0) || 0 }`.

- [ ] **Step 5: Orders store, migration, webhook**

`migrations/0007_tax.sql`:
```sql
-- Plan 5 (D37): sales tax Stripe collected on the session, in cents.
ALTER TABLE orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
```
`src/store/orders.ts`: `Order` gains `taxCents: number;` (after `vaseCents`), `Row` gains `tax_cents: number;`, `COLS` gains `tax_cents` after `vase_cents`, `fromRow` maps it. `markPaidBySession`:
```ts
export async function markPaidBySession(
  db: D1Database, sessionId: string, paymentIntent: string, taxCents: number, extra: D1PreparedStatement[] = [],
): Promise<Order | null> {
  const [upd] = await db.batch([
    db.prepare(
      `UPDATE orders SET status = 'paid', stripe_payment_intent = ?, tax_cents = ?, hold_expires_at = NULL
       WHERE stripe_session_id = ? AND status IN ('held', 'cancelled')`,
    ).bind(paymentIntent, taxCents, sessionId),
    ...extra,
  ]);
```
`src/routes/webhooks.ts`: `markPaidBySession(c.env.DB, event.sessionId, event.paymentIntent, event.taxCents, enqueueForSessionStatements(...))`.

- [ ] **Step 6: Checkout route and email**

`src/routes/public.ts`: tag the line items — bouquet `taxCategory: "flowers"`, Vase `taxCategory: "vase"`, Delivery `taxCategory: "delivery"` — and pass into `payments.createCheckout`:
```ts
        orderId, customerEmail: body.customer.email, customerName: body.customer.name,
        taxAddress: body.fulfillment === "delivery" ? body.delivery!.address : config.studio.address,
        lineItems,
```
`src/core/messages.ts` `customerEmail`: after the delivery line and before the total,
```ts
  if (order.taxCents > 0) lines.push(`  Sales tax: ${dollars(order.taxCents)}`);
  if (order.vaseCents > 0 || order.deliveryCents > 0 || order.taxCents > 0) {
    lines.push(`  Total: ${dollars(order.bouquetCents + order.vaseCents + order.deliveryCents + order.taxCents)}`);
  }
```
(this replaces the Total line added in Task 3).

- [ ] **Step 7: Run everything and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green. `RecordingPayments` in `tests/helpers.ts` records the input unchanged and needs no edit.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(payments): Stripe Tax on every session with the delivery address as tax location; promotion codes (D37, D40)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Day grid accessibility

**Files:**
- Modify: `site/store.js:212-243` (`renderDays`) and the `change` handler
- Modify: `site/index.html` (a `.sr` utility class; `#day-note` already has no live region)

No automated test covers the static page; verify by reading the DOM in a browser or with `grep`.

- [ ] **Step 1: Screen-reader-only class and live day note**

`site/index.html` in the `<style>` block, next to `.form-note`: `.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`. Change the day note element to `<p class="form-note" id="day-note" role="status" aria-live="polite"></p>`.

- [ ] **Step 2: Labels in renderDays**

`site/store.js` `renderDays`: replace the header loop with
```js
    var HEAD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    HEAD.forEach(function (full) {
      var e = document.createElement('div'); e.className = 'h';
      e.innerHTML = '<span aria-hidden="true"></span><span class="sr"></span>';
      e.firstChild.textContent = full.charAt(0); e.lastChild.textContent = full;
      cal.appendChild(e);
    });
```
and after `el.title = human(cur);` add
```js
        inp.setAttribute('aria-label', human(cur) + (d.orderable ? (d.remaining <= 2 ? ', ' + d.remaining + ' left' : '') : ', sold out'));
```
In the form `change` handler, the date branch becomes:
```js
    if (n === 'date') { dayNote.textContent = 'Chosen: ' + human(e.target.value) + '. Same-day orders close at the morning cutoff.'; refreshTotal(); askForQuote(); return; }
```

- [ ] **Step 3: Check**

Run: `grep -c "aria-label" site/store.js` (expect at least 1) and `npx vitest run tests/smoke.test.ts`.
Expected: smoke test green.

- [ ] **Step 4: Commit**

```bash
git add site/index.html site/store.js
git commit -m "a11y(site): full dates and weekday names on the day grid; chosen day is announced (D39)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Integration, spec §9, deploy (lead, not a subagent)

- [ ] Merge Task 1, 2, 5 branches; rebase and merge Task 3; then run Task 4 on the merged tree; `npx vitest run && npx tsc --noEmit`.
- [ ] Append to `docs/superpowers/specs/2026-09-07-store-design.md` §9 and Plan 5 spec: what shipped, commits, the preview verification results.
- [ ] Push the branch; Ryan pushes main; verify on production per the spec §5 list (three quotes via curl, one vase order to Checkout showing tax, promo code flow).
