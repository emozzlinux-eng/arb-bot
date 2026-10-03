#!/usr/bin/env bash
# =============================================================================
# stop.sh — graceful pm2 shutdown. Sends SIGINT first (bot flushes RPC calls,
# closes Telegram polling), then deletes the process from pm2's list so it
# won't resurrect on `pm2 resurrect` unexpectedly.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="flash-loan-arb"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }

command -v pm2 >/dev/null 2>&1 || { echo "pm2 not installed — nothing to stop."; exit 0; }

if ! pm2 describe "$APP" >/dev/null 2>&1; then
  say "Bot is not registered with pm2."
  exit 0
fi

say "Graceful stop (SIGINT → up to 5s for in-flight txs)…"
pm2 stop "$APP" --silent

# Safety net: if a stuck handler ignored SIGINT within kill_timeout, ensure gone.
sleep 1
STATE="$(pm2 jlist | tr -d '\n' | grep -o "\"name\":\"$APP\"[^}]*\"status\":\"[a-z]*\"" | grep -o '"status":"[a-z]*"' | tail -1 || true)"
if [[ "$STATE" == *"online"* || "$STATE" == *"launching"* ]]; then
  say "Still alive → forcing delete…"
  pm2 delete "$APP" --silent
fi

pm2 save --force >/dev/null 2>&1 || true
say "✅ Stopped and deregistered. Re-arm with arb-start."
