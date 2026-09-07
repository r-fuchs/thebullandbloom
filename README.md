# The Bull and Bloom

thebullandbloom.com — floral design by Anthony Demonia. Static site plus a Cloudflare Worker store.

- `site/` — the pages and images (no build step).
- `src/` — the Worker: `/api/*` for the storefront, `/webhooks/stripe`, `/admin/api/*`.
- `migrations/` — D1 schema.
- `store.config.json` — menu, prices, capacity defaults.
- Design: `docs/superpowers/specs/2026-09-07-store-design.md`.

`npm test` runs everything in a local workerd with a throwaway D1. `npm run dev` serves locally.
