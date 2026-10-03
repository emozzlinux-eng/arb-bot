#!/usr/bin/env bash
# =============================================================================
# update.sh — pull latest code, reinstall deps deterministically, rebuild,
# and restart the bot ONLY if it was running beforehand.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }

# Remember whether pm2 had us running so we can restore state exactly.
WAS_RUNNING=0
if command -v pm2 >/dev/null 2>&1; then
  pm2 describe flash-loan-arb >/dev/null 2>&1 && WAS_RUNNING=1
fi

say "Fetching origin…"
git fetch --all --prune
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
LOCAL="$(git rev-parse @)"; REMOTE="$(git rev-parse "@{u}" 2>/dev/null || echo none)"
if [ "$LOCAL" != "$REMOTE" ] && [ "$REMOTE" != "none" ]; then
  say "Pulling $BRANCH (fast-forward only — protects local edits)…"
  git pull --ff-only origin "$BRANCH"
else
  say "Already up to date."
fi

say "Reinstalling node deps (npm ci = lockfile-exact, no resolution churn)…"
cd "$ROOT/bot"
[ -f package-lock.json ] && npm ci || npm install

say "Updating Foundry libs + rebuilding contracts…"
cd "$ROOT/contracts"
forge update 2>/dev/null || true           # zero-dep project: fine if no lib/
forge build --sizes

say "Rebuilding TypeScript…"
cd "$ROOT/bot" && npm run build

if [ "$WAS_RUNNING" = "1" ]; then
  say "Bot was running → graceful restart…"
  pm2 restart flash-loan-arb --update-env
  say "✅ Updated & restarted."
else
  say "✅ Updated. Bot was NOT running — left stopped."
fi
