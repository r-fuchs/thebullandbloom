# Store Plan 6 — admin sign-in with Google through Cloudflare Access: Spec and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin passcode goes away. Every `/admin/api/*` request must carry a Cloudflare Access identity token, verified in the Worker against the team's public keys, and the admin page shows who is signed in.

**Architecture:** Cloudflare Access (application "Bull and Bloom admin", policy `bull-and-bloom-admins`, Google login only) already guards `thebullandbloom.com/admin` and `www.thebullandbloom.com/admin` at the edge. On every request it passes, Cloudflare adds the `Cf-Access-Jwt-Assertion` header (and the `CF_Authorization` cookie), an RS256 JWT whose `aud` is the application's audience tag and whose issuer is the team domain. The Worker verifies that token with a small adapter (`Access` interface, real implementation fetching the team JWKS, test fake) so the check also holds on the workers.dev preview address, which Access does not cover. No session cookie, no passcode, no login endpoint.

**Tech Stack:** Cloudflare Worker (Hono), WebCrypto `RSASSA-PKCS1-v1_5` for RS256, vitest-pool-workers. Admin page is ES5.

**Spec (decisions made with Ryan 2026-09-15):**
- D42: Access application created by Claude in the Cloudflare One dashboard (account `Ryan@fuchsassociates.com's Account`): destinations `thebullandbloom.com/admin` and `www.thebullandbloom.com/admin`; login method Google only, instant auth on; policy `bull-and-bloom-admins` allows `thebullandbloom@gmail.com` and `ryan@fuchsassociates.com`; session 24h. Team domain `foxnacre.cloudflareaccess.com`; application audience tag `f9355393f8797f54fa183665e0e05c916768693c32c95015452bfbf0f70972c0`.
- D43: The passcode is retired entirely (no fallback). If Google is down, Ryan enables Cloudflare's one-time-PIN login method on the application; no code change.
- D44: Team domain and audience tag are plain Worker vars (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`) in `wrangler.toml` `[vars]`; they are not secrets. `ADMIN_PASSCODE` is no longer read anywhere. `ADMIN_SECRET` stays (Google token encryption, quote signing).
- D45: Verification rules: header `alg` must be `RS256`; `aud` (string or array) must contain the configured tag; `iss` must equal `https://<team domain>`; `exp` must be in the future and `nbf`, when present, not; the key is looked up by `kid` in `https://<team domain>/cdn-cgi/access/certs` (`keys[]`), cached in the isolate for one hour; an unknown `kid` refetches once. The verified identity is `{ email }` from the payload's `email` claim.
- Sign out is Cloudflare's own `/cdn-cgi/access/logout` on the site domain.

## Global Constraints

- Admin page JS (`site/admin/index.html`) is ES5: `var`, `function`, no arrow functions, no template literals, no `const`/`let`.
- `npx vitest run` and `npx tsc --noEmit` clean before every commit. Commit messages `type(scope): summary` ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Header name is case-insensitive in Hono: read it as `c.req.header("cf-access-jwt-assertion")`. Cookie name is exactly `CF_Authorization`.
- Test bindings (vitest.config.ts `miniflare.bindings`): add `CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com"`, `CF_ACCESS_AUD: "test-aud"`; remove `ADMIN_PASSCODE`.
- Worktree note: `node_modules` is a symlink there; stage with `git add -A -- src site tests migrations docs wrangler.toml vitest.config.ts README.md .github`, never bare `git add -A`.

---

### Task 1: Access adapter, fake, and unit test

**Files:**
- Create: `src/adapters/access.ts`
- Create: `tests/fakes/access.ts`
- Test: `tests/adapters/access.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AdminIdentity { email: string }
export interface Access {
  /** the signed-in admin for a Cloudflare Access JWT, or null when missing, malformed, expired, for another app, or badly signed */
  verify(token: string | undefined, nowSec: number): Promise<AdminIdentity | null>;
}
export class CloudflareAccess implements Access {
  constructor(teamDomain: string, aud: string, fetchFn?: typeof fetch);
}
```
and the fake:
```ts
export class FakeAccess implements Access {
  /** every token the fake was asked about, newest last */
  seen: Array<string | undefined> = [];
  denyAll = false;
  async verify(token: string | undefined): Promise<AdminIdentity | null> {
    this.seen.push(token);
    if (this.denyAll || !token || !token.startsWith("test:")) return null;
    return { email: token.slice(5) };
  }
}
```

- [ ] **Step 1: Write the failing test** `tests/adapters/access.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { CloudflareAccess } from "../../src/adapters/access";

const enc = new TextEncoder();
function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair(kid: string) {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { priv: kp.privateKey, jwk: { ...jwk, kid, use: "sig", alg: "RS256" } };
}
async function sign(priv: CryptoKey, kid: string, payload: Record<string, unknown>, alg = "RS256") {
  const h = b64url(JSON.stringify({ alg, kid, typ: "JWT" })), p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
function jwksFetch(keys: JsonWebKey[]) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify({ keys, public_cert: {}, public_certs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const TEAM = "foxnacre.cloudflareaccess.com", AUD = "aud-1", NOW = 1_800_000_000;
const good = { aud: [AUD], iss: `https://${TEAM}`, email: "anthony@example.com", exp: NOW + 600, nbf: NOW - 60, iat: NOW - 60, sub: "u1" };

describe("CloudflareAccess.verify", () => {
  it("accepts a token signed by a key from the team's certs endpoint and returns the email", async () => {
    const k = await keypair("k1"); const { fn, calls } = jwksFetch([k.jwk]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    expect(await a.verify(await sign(k.priv, "k1", good), NOW)).toEqual({ email: "anthony@example.com" });
    expect(calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });
  it("caches the certs: a second token does not refetch", async () => {
    const k = await keypair("k1"); const { fn, calls } = jwksFetch([k.jwk]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    await a.verify(await sign(k.priv, "k1", good), NOW);
    await a.verify(await sign(k.priv, "k1", good), NOW + 10);
    expect(calls).toHaveLength(1);
  });
  it("refetches once for an unknown kid, then rejects", async () => {
    const k = await keypair("k2"); const { fn, calls } = jwksFetch([]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    expect(await a.verify(await sign(k.priv, "k2", good), NOW)).toBeNull();
    expect(calls).toHaveLength(2);
  });
  it("rejects a tampered payload, a foreign audience, a foreign issuer, an expired token, a not-yet-valid token, and a non-RS256 header", async () => {
    const k = await keypair("k1"); const a = new CloudflareAccess(TEAM, AUD, jwksFetch([k.jwk]).fn);
    const t = await sign(k.priv, "k1", good);
    const [h, , s] = t.split(".");
    expect(await a.verify(`${h}.${b64url(JSON.stringify({ ...good, email: "evil@example.com" }))}.${s}`, NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, aud: ["other"] }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, iss: "https://other.cloudflareaccess.com" }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, exp: NOW - 1 }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, nbf: NOW + 60 }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", good, "HS256"), NOW)).toBeNull();
  });
  it("accepts a string aud and rejects a token with no email, garbage, or nothing", async () => {
    const k = await keypair("k1"); const a = new CloudflareAccess(TEAM, AUD, jwksFetch([k.jwk]).fn);
    expect(await a.verify(await sign(k.priv, "k1", { ...good, aud: AUD }), NOW)).toEqual({ email: "anthony@example.com" });
    expect(await a.verify(await sign(k.priv, "k1", { ...good, email: undefined }), NOW)).toBeNull();
    expect(await a.verify("not.a.jwt", NOW)).toBeNull();
    expect(await a.verify("", NOW)).toBeNull();
    expect(await a.verify(undefined, NOW)).toBeNull();
  });
  it("never throws when the certs endpoint is down", async () => {
    const k = await keypair("k1");
    const down = (async () => { throw new Error("dns"); }) as unknown as typeof fetch;
    const a = new CloudflareAccess(TEAM, AUD, down);
    expect(await a.verify(await sign(k.priv, "k1", good), NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/adapters/access.test.ts`
Expected: fails to import `CloudflareAccess`.

- [ ] **Step 3: Implement** `src/adapters/access.ts`

```ts
/**
 * Cloudflare Access identity for the admin (Plan 6, D42–D45). Access guards /admin at the edge and
 * stamps every request it passes with an RS256 JWT (`Cf-Access-Jwt-Assertion` header, `CF_Authorization`
 * cookie). Verifying it here means the workers.dev address, which Access does not cover, is closed too.
 */
export interface AdminIdentity { email: string }

export interface Access {
  /** the signed-in admin for a Cloudflare Access JWT, or null when missing, malformed, expired, for another app, or badly signed */
  verify(token: string | undefined, nowSec: number): Promise<AdminIdentity | null>;
}

const CERTS_TTL_SEC = 3600;
const dec = new TextDecoder();
const enc = new TextEncoder();

function unb64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Jwk extends JsonWebKey { kid?: string }

export class CloudflareAccess implements Access {
  private certs: { at: number; keys: Jwk[] } | null = null;

  constructor(
    private teamDomain: string,
    private aud: string,
    private fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async verify(token: string | undefined, nowSec: number): Promise<AdminIdentity | null> {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let header: { alg?: string; kid?: string }, payload: Record<string, unknown>;
    try {
      header = JSON.parse(dec.decode(unb64url(parts[0])));
      payload = JSON.parse(dec.decode(unb64url(parts[1])));
    } catch { return null; }
    if (header?.alg !== "RS256" || typeof header.kid !== "string") return null;
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.aud) : aud === this.aud;
    if (!audOk) return null;
    if (payload.iss !== `https://${this.teamDomain}`) return null;
    if (typeof payload.exp !== "number" || payload.exp <= nowSec) return null;
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > nowSec)) return null;
    if (typeof payload.email !== "string" || payload.email === "") return null;

    let jwk = await this.keyFor(header.kid, nowSec, false);
    if (!jwk) jwk = await this.keyFor(header.kid, nowSec, true);
    if (!jwk) return null;
    try {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
      return ok ? { email: payload.email } : null;
    } catch {
      return null;
    }
  }

  private async keyFor(kid: string, nowSec: number, force: boolean): Promise<Jwk | null> {
    if (force || !this.certs || nowSec - this.certs.at > CERTS_TTL_SEC) {
      try {
        const res = await this.fetchFn(`https://${this.teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const body = await res.json() as { keys?: Jwk[] };
        this.certs = { at: nowSec, keys: Array.isArray(body.keys) ? body.keys : [] };
      } catch (err) {
        console.error("access: could not fetch team certs", err);
        return null;
      }
    }
    return this.certs.keys.find((k) => k.kid === kid) ?? null;
  }
}
```
and `tests/fakes/access.ts` exactly as in Interfaces above (import the types from `../../src/adapters/access`).

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/adapters/access.test.ts && npx tsc --noEmit`
Expected: 6 tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/access.ts tests/fakes/access.ts tests/adapters/access.test.ts
git commit -m "feat(access): Cloudflare Access JWT verifier with a test fake (D45)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Wire it in, retire the passcode, admin page shows who is signed in

**Files:**
- Modify: `src/env.ts` (drop `ADMIN_PASSCODE`; add `CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string`)
- Modify: `src/app.ts` (`Services.access: Access`; `Variables` gains `admin: AdminIdentity`)
- Modify: `src/index.ts` (construct `CloudflareAccess`; required-env list)
- Modify: `src/routes/admin.ts:1-63`
- Delete: `src/admin/session.ts`, `tests/admin/session.test.ts`
- Modify: `wrangler.toml` (`[vars]` + secrets comment), `vitest.config.ts` (bindings), `tests/setup.ts` (env type), `README.md:15,19`, `.github/workflows/deploy.yml:14` comment
- Modify: `tests/helpers.ts` (services gain `access: FakeAccess`; new `asAdmin`), the five test files that define their own `login()` (`tests/routes/admin.test.ts`, `admin-delivery.test.ts`, `admin-google.test.ts`, `instagram.test.ts`, `subscriptions.test.ts`), `tests/index.test.ts`
- Modify: `site/admin/index.html`

**Interfaces:**
- Consumes: `Access`, `AdminIdentity`, `CloudflareAccess`, `FakeAccess` from Task 1.
- Produces: `GET /admin/api/me` → `{ email }`; `asAdmin(fetch, email?)` test helper; middleware sets `c.set("admin", identity)`.

- [ ] **Step 1: Write the failing tests**

`tests/helpers.ts`: import `FakeAccess`; `testApp` and `testServices` construct `const access = new FakeAccess();`, pass `access` in the services object and return it. Add:
```ts
/** A fetch that carries a Cloudflare Access identity the FakeAccess accepts (Plan 6). */
export function asAdmin(fetch: (path: string, init?: RequestInit) => Promise<Response>, email = "ryan@fuchsassociates.com") {
  return (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "cf-access-jwt-assertion": `test:${email}`, "content-type": "application/json" } });
}
```
In each of the five test files, delete the local `login()` function and replace every `const as = await login(fetch);` with `const as = asAdmin(fetch);` (import `asAdmin` from `../helpers`). `tests/routes/admin.test.ts` currently has login-related tests (wrong passcode, missing cookie, logout); replace them with:
```ts
describe("admin identity (Cloudflare Access)", () => {
  it("refuses a request with no Access token", async () => {
    const { fetch, access } = testApp();
    const r = await fetch("/admin/api/month?from=2026-09-01&to=2026-09-30");
    expect(r.status).toBe(401);
    expect(access.seen).toEqual([undefined]);
  });
  it("refuses a token the verifier rejects", async () => {
    const { fetch, access } = testApp();
    access.denyAll = true;
    expect((await asAdmin(fetch)("/admin/api/month?from=2026-09-01&to=2026-09-30")).status).toBe(401);
  });
  it("accepts the CF_Authorization cookie as well as the header", async () => {
    const { fetch } = testApp();
    const r = await fetch("/admin/api/me", { headers: { cookie: "CF_Authorization=test:anthony@example.com" } });
    expect(await r.json()).toEqual({ email: "anthony@example.com" });
  });
  it("/me says who is signed in", async () => {
    const { fetch } = testApp();
    expect(await (await asAdmin(fetch, "thebullandbloom@gmail.com")("/admin/api/me")).json()).toEqual({ email: "thebullandbloom@gmail.com" });
  });
  it("no longer has a login or logout endpoint", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/login", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await asAdmin(fetch)("/admin/api/logout", { method: "POST" })).status).toBe(404);
  });
});
```
`tests/index.test.ts`: the misconfigured test also covers a missing Access var:
```ts
    const noAccess = { ...env, CF_ACCESS_AUD: "" };
    const r2 = await worker.fetch(new Request("https://example.com/api/health"), noAccess, ctx);
    expect(r2.status).toBe(500);
```
Delete `tests/admin/session.test.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/routes/admin.test.ts tests/index.test.ts`
Expected: type errors on `access`/`asAdmin`, 401/404 mismatches.

- [ ] **Step 3: Implement**

`src/env.ts`: remove `ADMIN_PASSCODE`; add `CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string;` with the comment "Plan 6: Cloudflare Access team domain (foxnacre.cloudflareaccess.com) and the admin application's audience tag; plain vars in wrangler.toml".

`src/app.ts`: `import type { Access, AdminIdentity } from "./adapters/access";` `Services` gains `access: Access;` and `App = Hono<{ Bindings: Env; Variables: { services: Services; admin: AdminIdentity } }>`.

`src/index.ts`: `import { CloudflareAccess } from "./adapters/access";` `const access = new CloudflareAccess(env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);` into services; `REQUIRED_SECRETS` becomes `REQUIRED_ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "ADMIN_SECRET", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"] as const` (rename the function's message to "misconfigured: missing").

`src/routes/admin.ts`: drop the session import and `setCookie`/`deleteCookie`; keep `getCookie`. Delete the login route, the logout route and `TTL`. The middleware becomes:
```ts
  // Plan 6: Cloudflare Access signs every admin request; the Worker checks the signature itself so the
  // workers.dev address, which Access does not front, is closed too. No session, no passcode.
  r.use("/admin/api/*", async (c, next) => {
    const { access, clock } = c.get("services");
    const nowSec = Math.floor(clock().getTime() / 1000);
    const token = c.req.header("cf-access-jwt-assertion") ?? getCookie(c, "CF_Authorization");
    const admin = await access.verify(token, nowSec);
    if (!admin) return c.json({ error: "unauthorized" }, 401);
    c.set("admin", admin);
    await next();
  });

  r.get("/admin/api/me", (c) => c.json({ email: c.get("admin").email }));
```
Delete `src/admin/session.ts` (and the directory if empty).

`wrangler.toml` `[vars]`: add
```toml
CF_ACCESS_TEAM_DOMAIN = "foxnacre.cloudflareaccess.com"
CF_ACCESS_AUD = "f9355393f8797f54fa183665e0e05c916768693c32c95015452bfbf0f70972c0"
```
and remove `ADMIN_PASSCODE` from the secrets comment. `vitest.config.ts`: replace the `ADMIN_PASSCODE` binding with `CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com", CF_ACCESS_AUD: "test-aud"`. `tests/setup.ts`: same on the env type. `README.md`: line 15 lists three required secrets (drop `ADMIN_PASSCODE`); line 19 becomes "Admin sign-in is Cloudflare Access with Google (Plan 6): the application, policy and login method live in the Cloudflare One dashboard; the Worker verifies the Access token on every `/admin/api` request using `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` from `wrangler.toml`. Rate limiting for `/api/checkout` and `/api/quote` is configured as Cloudflare rules at deploy, not in code." `.github/workflows/deploy.yml` comment: drop `ADMIN_PASSCODE`.

`site/admin/index.html`:
- Remove the `<form id="login">` block entirely. Add, inside the `#app` toolbar next to the Sign out button, `<span class="status" id="who"></span>`. Add below the toolbar (or wherever the page's status area is) `<p class="status" id="auth-status" hidden>Your sign-in has expired. <a href="/admin/">Reload to sign in with Google.</a></p>`.
- `show(authed)` becomes: `function show(authed) { $('#app').hidden = !authed; $('#auth-status').hidden = authed; }`.
- Replace the `#login` submit handler with a start-up call:
```js
  api('/me').then(function (me) { $('#who').textContent = me.email; show(true); loadMonth(); })
    .catch(function () { show(false); });
```
(Remove any other start-up call that previously ran after login, so `loadMonth()` runs once.)
- The Sign out handler becomes `$('#logout').addEventListener('click', function () { location.href = '/cdn-cgi/access/logout'; });`.
- In the shared `api()` helper, where a 401 currently calls `show(false)` (or throws "unauthorized"), keep the `show(false)` so the expired message appears.
- Delete the `#login`-related CSS if any is specific to it.

- [ ] **Step 4: Run everything and typecheck**

Run: `npx vitest run && npx tsc --noEmit && node -e "require('fs').readFileSync('site/admin/index.html','utf8').includes('admin/api/login') && process.exit(1)"`
Expected: all green; no remaining reference to the login endpoint or `passcode` in `src/`, `site/`, `tests/` (`grep -rn "passcode\|ADMIN_PASSCODE\|bb_admin" src site tests` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add -A -- src site tests wrangler.toml vitest.config.ts README.md .github
git commit -m "feat(admin): sign in with Google through Cloudflare Access; passcode retired (D42–D45)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Verify live (lead)

- [ ] Push the branch; Ryan pushes main. After the deploy: `curl -s -o /dev/null -w "%{http_code}" https://thebullandbloom.com/admin/api/me` is 302 to the Access login (edge), and `curl -s https://thebullandbloom.thebullandbloom.workers.dev/admin/api/me` is 401 (Worker). Ryan signs in with Google at thebullandbloom.com/admin and sees his email in the toolbar; Anthony does the same.
- [ ] Ryan deletes the retired secret: `npx wrangler secret delete ADMIN_PASSCODE`.

## Outcome (2026-09-15 evening)

Shipped: `f6ac1a0`..`50fd1f8` on main, deploy green, 334 tests. Live checks: `thebullandbloom.com/admin/api/me`
302s to the Access login at foxnacre.cloudflareaccess.com; the workers.dev address answers 401 with no token
and 401 with a forged token; `/api/health` 200. Left for Ryan: `npx wrangler secret delete ADMIN_PASSCODE` and
dropping the line from `.dev.vars`; sign in once to confirm the email shows; Anthony the same.
