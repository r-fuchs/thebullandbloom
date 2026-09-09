# The Bull and Bloom

thebullandbloom.com — floral design by Anthony Demonia. Static site plus a Cloudflare Worker store.

- `site/` — the pages and images (no build step).
- `src/` — the Worker: `/api/*` for the storefront, `/webhooks/stripe`, `/admin/api/*`.
- `migrations/` — D1 schema.
- `store.config.json` — menu, prices, capacity defaults.
- Design: `docs/superpowers/specs/2026-09-07-store-design.md`.

`npm test` runs everything in a local workerd with a throwaway D1. `npm run dev` serves locally.

## Local development

1. Create `.dev.vars` with the six secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_PASSCODE`, `ADMIN_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are optional locally; without them the admin Google panel says "not set up".
2. Run `npx wrangler d1 migrations apply bullandbloom --local`.
3. Run `npm run dev`.

`ADMIN_PASSCODE` must be a generated string of at least 20 characters. Rate limiting for `/admin/api/login` and `/api/checkout` is configured as Cloudflare rules at deploy, not in code.

## Deploy

`npm run deploy` publishes the Worker and `site/`. Secrets live in Cloudflare (`wrangler secret put`), never in the repo.
Migrations: `npx wrangler d1 migrations apply bullandbloom --remote`. Stripe webhook endpoint: `/webhooks/stripe`.
Preview URL until DNS cutover: https://thebullandbloom.thebullandbloom.workers.dev

Google: `scripts/google-setup.sh` uploads the OAuth client secrets, applies migrations, and redeploys to the preview. Anthony connects from admin → Google. The OAuth client's redirect URIs must include `<site>/admin/google/callback` for both the preview and thebullandbloom.com.
