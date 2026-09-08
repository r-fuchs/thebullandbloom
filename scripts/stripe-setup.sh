#!/usr/bin/env bash
# One-shot Stripe wiring for the deployed Worker (plan Task 15, steps 2–4).
# Reads STRIPE_SECRET_KEY from .dev.vars (never from the command line), creates the
# webhook endpoint through the Stripe API, uploads both Stripe secrets to Cloudflare,
# and redeploys with SITE_URL pointed at the preview so Stripe redirects land there.
# Usage: scripts/stripe-setup.sh [preview-url]
set -euo pipefail
cd "$(dirname "$0")/.."

PREVIEW="${1:-https://thebullandbloom.thebullandbloom.workers.dev}"
ENDPOINT="$PREVIEW/webhooks/stripe"

[ -f .dev.vars ] || { echo "no .dev.vars — add a line: STRIPE_SECRET_KEY=sk_test_..." >&2; exit 2; }
KEY=$(sed -n 's/^STRIPE_SECRET_KEY=//p' .dev.vars | tr -d '"'"'"' \r')
case "$KEY" in
  sk_test_*) ;;
  sk_live_*) echo "refusing: that is a LIVE key; use the test-mode key for now" >&2; exit 2 ;;
  *) echo ".dev.vars STRIPE_SECRET_KEY is missing or not an sk_test_ key" >&2; exit 2 ;;
esac

echo "→ checking the key against Stripe"
ACCT=$(curl -sS -u "$KEY:" https://api.stripe.com/v1/account)
python3 - "$ACCT" <<'PY'
import json,sys
a=json.loads(sys.argv[1])
if "error" in a: print("Stripe rejected the key:", a["error"].get("message")); sys.exit(1)
print("  account:", a.get("id"), "|", (a.get("settings",{}).get("dashboard",{}) or {}).get("display_name") or a.get("business_profile",{}).get("name") or "(no name)", "| charges_enabled:", a.get("charges_enabled"))
PY

echo "→ finding or creating the webhook endpoint $ENDPOINT"
EXISTING=$(curl -sS -u "$KEY:" "https://api.stripe.com/v1/webhook_endpoints?limit=100")
WHID=$(python3 - "$EXISTING" "$ENDPOINT" <<'PY'
import json,sys
d=json.loads(sys.argv[1]); url=sys.argv[2]
for e in d.get("data",[]):
    if e.get("url")==url: print(e["id"]); break
PY
)
if [ -n "$WHID" ]; then
  echo "  endpoint exists ($WHID); Stripe only reveals a signing secret at creation, so recreating it"
  curl -sS -u "$KEY:" -X DELETE "https://api.stripe.com/v1/webhook_endpoints/$WHID" >/dev/null
fi
CREATED=$(curl -sS -u "$KEY:" https://api.stripe.com/v1/webhook_endpoints \
  -d "url=$ENDPOINT" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=checkout.session.expired" \
  -d "description=The Bull and Bloom store (preview)")
WHSEC=$(python3 - "$CREATED" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
if "error" in d: print("ERR "+d["error"].get("message","")); sys.exit(0)
print(d["secret"])
PY
)
case "$WHSEC" in whsec_*) ;; *) echo "webhook creation failed: $WHSEC" >&2; exit 1 ;; esac
echo "  created; signing secret received"

echo "→ uploading secrets to Cloudflare"
printf '%s' "$KEY"   | npx wrangler secret put STRIPE_SECRET_KEY     2>&1 | grep -E "Success|rror" || true
printf '%s' "$WHSEC" | npx wrangler secret put STRIPE_WEBHOOK_SECRET 2>&1 | grep -E "Success|rror" || true
grep -q '^STRIPE_WEBHOOK_SECRET=' .dev.vars && sed -i '' "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=$WHSEC|" .dev.vars || echo "STRIPE_WEBHOOK_SECRET=$WHSEC" >> .dev.vars

echo "→ redeploying with SITE_URL=$PREVIEW (preview only; main config still says thebullandbloom.com)"
npx wrangler deploy --var "SITE_URL:$PREVIEW" 2>&1 | grep -E "Uploaded|Deployed|workers.dev|rror" || true

echo "→ checking the deployed Worker"
echo "  health: $(curl -sS "$PREVIEW/api/health")"
R=$(curl -sS -w ' [%{http_code}]' -X POST -H 'content-type: application/json' \
  -d '{"sizeId":"posy","date":"'"$(TZ=America/New_York date -v+2d +%F)"'","fulfillment":"pickup","customer":{"name":"Stripe Wiring Test","email":"ryan@thrivable.app"},"note":"setup script; abandon this checkout"}' \
  "$PREVIEW/api/checkout")
echo "  checkout: $R"
echo
echo "Done. If checkout shows a checkout.stripe.com url above, open it and pay with 4242 4242 4242 4242 (any future date, any CVC) to finish the walk-through, or just leave it; the hold releases itself in ~33 minutes."
