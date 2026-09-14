#!/usr/bin/env bash
# Cancel one Uber Direct delivery using the credentials in .dev.vars (test-mode by default).
# The Uber dashboard does not list sandbox deliveries, so this is the only way to cancel one
# during the Robocourier acceptance walk-through (plan Task 12 Step 4, check 5).
# Usage: scripts/uber-cancel.sh <uber_delivery_id>      e.g. del_jqNdYeeURgad4QJibQJK4A
set -euo pipefail
cd "$(dirname "$0")/.."
[ -n "${1:-}" ] || { echo "usage: $0 <uber_delivery_id>"; exit 1; }
set -a; . ./.dev.vars; set +a
TOKEN=$(curl -sS -X POST https://auth.uber.com/oauth/v2/token \
  -d client_id="$UBER_CLIENT_ID" -d client_secret="$UBER_CLIENT_SECRET" \
  -d grant_type=client_credentials -d scope=eats.deliveries \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")
[ -n "$TOKEN" ] || { echo "no access token — check UBER_CLIENT_ID/SECRET in .dev.vars"; exit 1; }
OUT=$(mktemp)
CODE=$(curl -sS -o "$OUT" -w "%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  "https://api.uber.com/v1/customers/$UBER_CUSTOMER_ID/deliveries/$1/cancel")
echo "cancel HTTP $CODE"
python3 -c "import json;d=json.load(open('$OUT'));print({k:d.get(k) for k in ('id','status','undeliverable_reason','code','message')})"
rm -f "$OUT"
