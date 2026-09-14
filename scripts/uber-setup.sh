#!/usr/bin/env bash
# One-shot Uber Direct wiring for the deployed Worker (Plan 3 Task 12). Reads the four Uber values
# from .dev.vars, uploads them as Cloudflare secrets, applies the delivery migration remotely, and
# redeploys the preview with Robocourier on so sandbox deliveries drive themselves.
# Usage: scripts/uber-setup.sh [preview-url]
set -euo pipefail
cd "$(dirname "$0")/.."

PREVIEW="${1:-https://thebullandbloom.thebullandbloom.workers.dev}"

[ -f .dev.vars ] || { echo "no .dev.vars — add the four UBER_* values" >&2; exit 2; }
read_var() { sed -n "s/^$1=//p" .dev.vars | tr -d '"'"'"' \r'; }
CID=$(read_var UBER_CLIENT_ID)
CSEC=$(read_var UBER_CLIENT_SECRET)
CUST=$(read_var UBER_CUSTOMER_ID)
WSEC=$(read_var UBER_WEBHOOK_SECRET)
for pair in "UBER_CLIENT_ID:$CID" "UBER_CLIENT_SECRET:$CSEC" "UBER_CUSTOMER_ID:$CUST" "UBER_WEBHOOK_SECRET:$WSEC"; do
  [ -n "${pair#*:}" ] || { echo ".dev.vars ${pair%%:*} is missing" >&2; exit 2; }
done

echo "→ applying migrations to the production D1 (adds deliveries + the courier outbox kind)"
npx wrangler d1 migrations apply bullandbloom --remote 2>&1 | grep -Ev '^\s*$' | tail -n 5

echo "→ uploading secrets to Cloudflare"
printf '%s' "$CID"  | npx wrangler secret put UBER_CLIENT_ID      2>&1 | grep -E "Success|rror" || true
printf '%s' "$CSEC" | npx wrangler secret put UBER_CLIENT_SECRET  2>&1 | grep -E "Success|rror" || true
printf '%s' "$CUST" | npx wrangler secret put UBER_CUSTOMER_ID    2>&1 | grep -E "Success|rror" || true
printf '%s' "$WSEC" | npx wrangler secret put UBER_WEBHOOK_SECRET 2>&1 | grep -E "Success|rror" || true

echo "→ redeploying with SITE_URL=$PREVIEW and Robocourier on (sandbox only)"
# --var replaces the whole [vars] block for this deploy, so SITE_URL has to be repeated here.
npx wrangler deploy --var "SITE_URL:$PREVIEW" --var "UBER_ROBOCOURIER:1" 2>&1 | grep -E "Uploaded|Deployed|workers.dev|rror" || true

echo "→ checking the deployed Worker"
echo "  health: $(curl -sS "$PREVIEW/api/health")"
echo "  config: $(curl -sS "$PREVIEW/api/config" | tr -d '\n' | sed 's/.*"delivery"/delivery/')"
echo
echo "Done. Open $PREVIEW/admin/ → Delivery; it should say Uber is set up."
echo "PRODUCTION LATER: re-run wrangler secret put with the live values and redeploy WITHOUT --var UBER_ROBOCOURIER."
