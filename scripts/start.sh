#!/usr/bin/env bash
# =============================================================================
# start.sh — launch the bot under pm2 so it survives terminal close / sleep.
# Usage: ./scripts/start.sh            (mode from .env / ecosystem default)
#        ARB_MODE=live ./scripts/start.sh
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

command -v pm2 >/dev/null 2>&1 || die "pm2 missing — run scripts/install.sh"
[ -f "$ROOT/.env" ] || die ".env missing — cp .env.example .env and edit it"
[ -f "$ROOT/bot/dist/index.js" ] || { say "dist/ missing → building…"; (cd "$ROOT/bot" && npm run build); }

MODE="${ARB_MODE:-demo}"
if [ "$MODE" = "live" ]; then
  grep -qE '^BOT_PRIVATE_KEY=0x[0-9a-fA-F]{64}' "$ROOT/.env" \
    || die "LIVE mode requested but BOT_PRIVATE_KEY not set in .env"
  say "Starting in LIVE mode ⚠️  (real transactions!)"
else
  say "Starting in DEMO mode (no real transactions)."
fi

# Idempotent: full delete + fresh start guarantees the right mode args.
pm2 delete flash-loan-arb >/dev/null 2>&1 || true
cd "$ROOT/bot"

if [ "$MODE" = "live" ]; then
  pm2 start ecosystem.config.cjs --only flash-loan-arb \
       --node-args="--max-old-space-size=384 --optimize-for-size" \
       --update-env -- --mode live
else
  pm2 start ecosystem.config.cjs --only flash-loan-arb
fi

pm2 save >/dev/null 2>&1 || true            # survive reboots (pm2 startup must be set once)
say "✅ Running under pm2. View: arb-logs | Status: pm2 status"
