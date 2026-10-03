#!/usr/bin/env bash
# =============================================================================
# upgrade.sh — major-version / clean-slate rebuild.
# Wipes node_modules, Foundry cache/artifacts, dist; reinstalls from lockfile.
# Use when: Node major bump, viem major bump, corrupted forge cache.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m WARN:\033[0m %s\n" "$*"; }

WAS_RUNNING=0
pm2 describe flash-loan-arb >/dev/null 2>&1 && WAS_RUNNING=1

say "Stopping bot before destructive ops…"
pm2 stop flash-loan-arb 2>/dev/null || true

# --- 1. Node.js major upgrade (optional prompt) ------------------------------
if command -v nvm >/dev/null 2>&1; then
  CURRENT_NODE="$(node --version | sed 's/v\([0-9]*\).*/\1/')"
  if [ "${CURRENT_NODE}" -lt 20 ]; then
    say "Node ${CURRENT_NODE} detected → upgrading to LTS v20 via nvm…"
    nvm install 20 && nvm alias default 20 && nvm use 20
  fi
else
  warn "nvm not found — skipping Node upgrade. Run scripts/install.sh first."
fi

# --- 2. Nuke build artifacts & caches ----------------------------------------
say "Clearing node_modules / dist / forge cache+out…"
rm -rf "$ROOT/bot/node_modules" "$ROOT/bot/dist" "$ROOT/bot/.tsbuildinfo"
rm -rf "$ROOT/contracts/cache" "$ROOT/contracts/out"

# npm's own stale cache can poison offline installs on slow disks
npm cache verify >/dev/null 2>&1 || true

# --- 3. Foundry toolchain refresh --------------------------------------------
if [ -x "$HOME/.foundry/bin/foundryup" ]; then
  say "foundryup — refreshing forge/cast/anvil to latest stable…"
  "$HOME/.foundry/bin/foundryup"
fi

# --- 4. Clean rebuild ---------------------------------------------------------
say "Fresh npm ci…"
cd "$ROOT/bot" && npm ci

say "Rebuilding TypeScript…"
npm run build

say "Rebuilding contracts…"
cd "$ROOT/contracts" && forge build --sizes

# --- 5. Restore prior run state -----------------------------------------------
if [ "$WAS_RUNNING" = "1" ]; then
  say "Restarting pm2 process…"
  cd "$ROOT" && ./scripts/start.sh
else
  say "✅ Upgrade complete (bot left stopped as before)."
fi
