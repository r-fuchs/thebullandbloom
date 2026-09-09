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
