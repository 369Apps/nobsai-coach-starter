#!/usr/bin/env bash
# Deploy a preview Worker named "nobsai-coach-preview".
#
# One command from the repo root:
#   pnpm deploy:preview
#
# Permanent account:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm deploy:preview
#
# With no Cloudflare token, this uses `wrangler --temporary`: a preview account
# that must be claimed within 60 minutes or Cloudflare deletes it.
# https://developers.cloudflare.com/workers/platform/claim-deployments/
#
# Stripe is test mode only. A live secret (sk_live_ / rk_live_) aborts the script.
# Missing model and Stripe values are not invented. Text coaching still runs on the
# offline rubric, and checkout stays disabled until the test secrets below are set.
#
# Required for a lasting deploy
#   CLOUDFLARE_API_TOKEN     API token with Workers and D1 edit on the account
#   CLOUDFLARE_ACCOUNT_ID    Account id (Wrangler needs it for some tokens)
#
# Secrets, set only when you have the real test values (wrangler secret put via stdin)
#   LLM_API_KEY              Voice and text model key. Without it, text scoring uses the offline rubric.
#   STRIPE_SECRET_KEY        sk_test_... or rk_test_... only
#   STRIPE_WEBHOOK_SECRET    whsec_... from the test webhook endpoint
#
# Non-secret test price ids, optional. Placeholders stay in the config until these are real price_ ids.
#   STRIPE_PRICE_VOICE       Stripe test price for the $20 plan
#   STRIPE_PRICE_LIVE        Stripe test price for the $100 plan
#   STRIPE_PRICE_COACH       Stripe test price for the $200 plan
#
# Not required for this preview. Magic links are shown on the sign-in page because
# ENVIRONMENT is "preview", not "production".
#   EMAIL_WEBHOOK_URL        Only when ENVIRONMENT=production

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG="$ROOT/wrangler.preview.jsonc"
DB_NAME="nobsai-coach-preview"
WORKER_NAME="nobsai-coach-preview"

if [[ -n "${STRIPE_SECRET_KEY:-}" ]]; then
  case "$STRIPE_SECRET_KEY" in
    sk_test_*|rk_test_*) ;;
    *)
      echo "Refusing to deploy. STRIPE_SECRET_KEY must be a Stripe test key (sk_test_ or rk_test_)." >&2
      exit 1
      ;;
  esac
fi

AUTH=()
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" || -n "${CLOUDFLARE_API_KEY:-}" ]]; then
  echo "Using the Cloudflare API token in the environment."
  if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo "CLOUDFLARE_ACCOUNT_ID is not set. Wrangler will try to infer the account from the token."
  fi
else
  AUTH=(--temporary)
  echo "No CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY."
  echo "Deploying with a temporary Cloudflare account (wrangler --temporary)."
  echo "Claim the URL Wrangler prints within 60 minutes, or the preview is deleted."
  echo "Continuing accepts Cloudflare's Terms of Service (https://www.cloudflare.com/terms/) and Privacy Policy (https://www.cloudflare.com/privacypolicy/)."
fi

echo
echo "Still unset (not invented):"
[[ -z "${LLM_API_KEY:-}" ]] && echo "  LLM_API_KEY"
[[ -z "${STRIPE_SECRET_KEY:-}" ]] && echo "  STRIPE_SECRET_KEY (test mode only)"
[[ -z "${STRIPE_WEBHOOK_SECRET:-}" ]] && echo "  STRIPE_WEBHOOK_SECRET"
[[ -z "${STRIPE_PRICE_VOICE:-}" ]] && echo "  STRIPE_PRICE_VOICE"
[[ -z "${STRIPE_PRICE_LIVE:-}" ]] && echo "  STRIPE_PRICE_LIVE"
[[ -z "${STRIPE_PRICE_COACH:-}" ]] && echo "  STRIPE_PRICE_COACH"
echo

wrangler() {
  pnpm exec wrangler "$@"
}

write_config() {
  local db_id="$1"
  local origin="$2"
  python3 - "$CONFIG" "$db_id" "$origin" "$DB_NAME" "$WORKER_NAME" << 'PY'
import json, os, sys
dest, db_id, origin, db_name, worker = sys.argv[1:]
prices = {}
for key in ("STRIPE_PRICE_VOICE", "STRIPE_PRICE_LIVE", "STRIPE_PRICE_COACH"):
    value = os.environ.get(key, "").strip()
    prices[key] = value if value.startswith("price_") and not value.startswith("price_test_") else {
        "STRIPE_PRICE_VOICE": "price_test_voice",
        "STRIPE_PRICE_LIVE": "price_test_live",
        "STRIPE_PRICE_COACH": "price_test_coach",
    }[key]
cfg = {
    "name": worker,
    "main": "src/index.ts",
    "compatibility_date": "2026-10-24",
    "compatibility_flags": ["nodejs_compat"],
    "observability": {"enabled": True, "traces": {"enabled": True}},
    "assets": {
        "directory": "./public",
        "binding": "ASSETS",
        "not_found_handling": "single-page-application",
        "run_worker_first": ["/api/*"],
    },
    "d1_databases": [{
        "binding": "DB",
        "database_name": db_name,
        "database_id": db_id,
        "migrations_dir": "migrations",
    }],
    "vars": {
        "ENVIRONMENT": "preview",
        "APP_ORIGIN": origin,
        "ADMIN_EMAILS": "",
        "CANONICAL_HOST": "",
        "LIVE_RATE_USD_PER_MINUTE": "",
        "LLM_API_BASE": "https://api.x.ai/v1",
        "FREE_TEXT_CAP_SECONDS": "600",
        "VOICE_DAILY_CAP_SECONDS": "900",
        "LIVE_DAILY_CAP_SECONDS": "900",
        "PAID_TEXT_SAFETY_CAP_SECONDS": "14400",
        "MIN_TEXT_TURN_SECONDS": "20",
        "VOICE_TURN_PAUSE_SECONDS": "2",
        "MAKEOVER_SECONDS": "60",
        "FREE_VOICE_DAILY_SESSIONS": "200",
        "LLM_TEXT_MODEL": "grok-4.7",
        "LLM_VOICE_MODEL": "grok-voice-latest",
        "LLM_STT_MODEL": "grok-voice-transcribe-2.0",
        "LLM_TTS_VOICE": "eve",
        "LLM_REALTIME_TRANSCRIBE_MODEL": "grok-transcribe",
        "BRAND_NAME": "No BS AI",
        "BRAND_HEADLINE": "Get hired as a Forward Deployed Engineer.",
        "BRAND_TRUST": "Built by No BS AI. Placement through DeployedX.",
        "BRAND_COACH": "Coach from Hire Me",
        "BRAND_PRODUCT": "Hire Me",
        "BRAND_BYLINE": "Free FDE coaching",
        "BRAND_PLACEMENT": "Placement through DeployedX is a separate path. The $200 plan is a weekly human coach and first pick of the sample roles.",
        **prices,
    },
}
json.dump(cfg, open(dest, "w"), indent=2)
open(dest, "a").write("\n")
PY
}

extract_uuid() {
  python3 -c 'import re,sys; text=sys.stdin.read(); ids=re.findall(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", text); ids=[i for i in ids if not i.startswith("00000000-")]; print(ids[-1] if ids else "")'
}

DB_ID=""
if [[ -f "$CONFIG" ]]; then
  DB_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["d1_databases"][0]["database_id"])' "$CONFIG")"
  if [[ "$DB_ID" == 00000000-* ]]; then
    DB_ID=""
  fi
fi

read_info_id() {
  python3 -c 'import json,sys; text=sys.stdin.read(); start=text.find("{"); data=json.loads(text[start:]); print(data.get("uuid") or data.get("database_id") or "")'
}

if [[ -z "$DB_ID" ]]; then
  set +e
  INFO_OUT="$(wrangler d1 info "$DB_NAME" --json "${AUTH[@]}" 2>&1)"
  INFO_CODE=$?
  set -e
  if [[ $INFO_CODE -eq 0 ]]; then
    DB_ID="$(printf '%s' "$INFO_OUT" | read_info_id)"
  else
    set +e
    CREATE_OUT="$(wrangler d1 create "$DB_NAME" "${AUTH[@]}" 2>&1)"
    CREATE_CODE=$?
    set -e
    printf '%s\n' "$CREATE_OUT"
    if [[ $CREATE_CODE -eq 0 ]]; then
      DB_ID="$(printf '%s' "$CREATE_OUT" | extract_uuid)"
    else
      set +e
      INFO_OUT="$(wrangler d1 info "$DB_NAME" --json "${AUTH[@]}" 2>&1)"
      INFO_CODE=$?
      set -e
      if [[ $INFO_CODE -ne 0 ]]; then
        printf '%s\n' "$INFO_OUT" >&2
        exit "$CREATE_CODE"
      fi
      DB_ID="$(printf '%s' "$INFO_OUT" | read_info_id)"
    fi
  fi
fi

if [[ -z "$DB_ID" ]]; then
  echo "Could not read the D1 database id for ${DB_NAME}." >&2
  exit 1
fi

write_config "$DB_ID" "https://${WORKER_NAME}.workers.dev"
echo "D1 ${DB_NAME} ${DB_ID}"

wrangler d1 migrations apply "$DB_NAME" --remote --config "$CONFIG" "${AUTH[@]}"

DEPLOY_OUT="$(wrangler deploy --config "$CONFIG" "${AUTH[@]}")"
printf '%s\n' "$DEPLOY_OUT"
ORIGIN="$(printf '%s' "$DEPLOY_OUT" | python3 -c 'import re,sys; m=re.findall(r"https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev", sys.stdin.read()); print(m[-1] if m else "")')"
if [[ -z "$ORIGIN" ]]; then
  echo "Deploy finished, but no workers.dev URL was printed." >&2
  exit 1
fi

CURRENT_ORIGIN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["vars"]["APP_ORIGIN"])' "$CONFIG")"
if [[ "$CURRENT_ORIGIN" != "$ORIGIN" ]]; then
  write_config "$DB_ID" "$ORIGIN"
  wrangler deploy --config "$CONFIG" "${AUTH[@]}"
fi

put_secret() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    return 0
  fi
  printf '%s' "$value" | wrangler secret put "$name" --config "$CONFIG" "${AUTH[@]}"
}

put_secret LLM_API_KEY "${LLM_API_KEY:-}"
put_secret STRIPE_SECRET_KEY "${STRIPE_SECRET_KEY:-}"
put_secret STRIPE_WEBHOOK_SECRET "${STRIPE_WEBHOOK_SECRET:-}"

echo
echo "Preview URL: ${ORIGIN}"
echo "Worker: ${WORKER_NAME}"
echo "D1: ${DB_NAME} (${DB_ID})"
echo "ENVIRONMENT=preview, so the sign-in screen shows the magic link."
if [[ ${#AUTH[@]} -gt 0 ]]; then
  echo "This is a temporary account. Claim it from the URL in the Wrangler output within 60 minutes."
fi
if [[ -z "${LLM_API_KEY:-}" ]]; then
  echo "Text coaching on this URL uses the offline rubric until LLM_API_KEY is set."
fi
if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  echo "Stripe checkout is off until STRIPE_SECRET_KEY (test mode) and the three price ids are set."
fi
