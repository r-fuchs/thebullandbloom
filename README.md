# The Bull and Bloom

thebullandbloom.com — floral design by Anthony Demonia. Static site plus a Cloudflare Worker store.

- `site/` — the pages and images (no build step).
- `src/` — the Worker: `/api/*` for the storefront, `/webhooks/stripe`, `/webhooks/uber`, `/admin/api/*`.
- `migrations/` — D1 schema.
- `store.config.json` — menu, prices, subscription grid (cadences × sizes, monthly price per cell), capacity defaults, studio address/phone/ready time, delivery zones (name, fee, ZIPs) and mode.
- Design: `docs/superpowers/specs/2026-09-07-store-design.md`.

`npm test` runs everything in a local workerd with a throwaway D1. `npm run dev` serves locally.

## Local development

1. Create `.dev.vars` with the three required secrets — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_SECRET` — plus whichever optional sets you want live: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (without them the admin Google panel says "not set up"), `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` (without them the Photos panel says the same), and `UBER_CLIENT_ID`/`UBER_CLIENT_SECRET`/`UBER_CUSTOMER_ID`/`UBER_WEBHOOK_SECRET` (without them every delivery address gets its zone fee from `delivery.zones` in `store.config.json`, or delivery is hidden when no zone lists a ZIP).
2. Run `npx wrangler d1 migrations apply bullandbloom --local`.
3. Run `npm run dev`.

Admin sign-in is Cloudflare Access with Google (Plan 6): the application, policy and login method live in the Cloudflare One dashboard; the Worker verifies the Access token on every `/admin/api` request using `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` from `wrangler.toml`. Rate limiting for `/api/checkout` and `/api/quote` is configured as Cloudflare rules at deploy, not in code (`/api/quote` is unauthenticated and calls Uber's metered quote API).

## Deploy

`npm run deploy` publishes the Worker and `site/`. Secrets live in Cloudflare (`wrangler secret put`), never in the repo.

From GitHub, without a laptop: Actions → Deploy → Run workflow on the branch you want, leaving the site URL at the preview default (`.github/workflows/deploy.yml`). It typechecks, runs the tests, applies migrations, and deploys. A push to `main` deploys production with the URL from `wrangler.toml`. The workflow needs two repository secrets, `CLOUDFLARE_API_TOKEN` (an "Edit Cloudflare Workers" token with D1 edit) and `CLOUDFLARE_ACCOUNT_ID`.
Migrations: `npx wrangler d1 migrations apply bullandbloom --remote`. Stripe webhook endpoint: `/webhooks/stripe`.
Preview URL until DNS cutover: https://thebullandbloom.thebullandbloom.workers.dev

Google: `scripts/google-setup.sh` uploads the OAuth client secrets, applies migrations, and redeploys to the preview. Anthony connects from admin → Google. The OAuth client's redirect URIs must include `<site>/admin/google/callback` for both the preview and thebullandbloom.com.

Uber Direct: `scripts/uber-setup.sh` reads the four `UBER_*` values from `.dev.vars`, uploads them as Cloudflare secrets, applies the delivery migration remotely, and redeploys the preview with `UBER_ROBOCOURIER=1` so sandbox deliveries drive themselves. Uber's dashboard needs the delivery-status webhook pointed at `<site>/webhooks/uber`. On a GitHub deploy, set the workflow's `uber_robocourier` input to `1` for a sandbox run and leave it empty for real couriers.
