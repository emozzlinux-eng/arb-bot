#!/usr/bin/env bash
# =============================================================================
# manage.sh — unified bot lifecycle: start | stop | restart | status | logs |
#             demo | live | update | health
# Optimized for 2017 MBA: everything goes through pm2 (fork mode, one heap).
# Usage: ./scripts/manage.sh <command> [args]
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="flash-loan-arb"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

need_pm2() { command -v pm2 >/dev/null 2>&1 || die "pm2 missing — run scripts/install.sh"; }
need_env() { [ -f "$ROOT/.env" ] || die ".env missing — cp .env.example .env and edit it"; }

ensure_dist() {
  if [ ! -f "$ROOT/bot/dist/index.js" ]; then
    say "dist/ missing → building…"
    (cd "$ROOT/bot" && npm run build)
  fi
}

configure_logrotate() {
  # Idempotent: install + tune pm2-logrotate so a chatty scanner can't fill
  # the (small) SSD. 10MB per file, keep 7, gzip compressed archives.
  need_pm2
  pm2 describe logrotate >/dev/null 2>&1 || pm2 install pm2-logrotate >/dev/null
  pm2 set pm2-logrotate:max_size 10M     >/dev/null
  pm2 set pm2-logrotate:retain 7         >/dev/null
  pm2 set pm2-logrotate:compress true    >/dev/null
  pm2 set pm2-logrotate:rotateInterval '0 3 * * *' >/dev/null   # daily 03:00 sanity rotate
}

cmd_start() {
  need_pm2; need_env; ensure_dist
  local mode="${1:-demo}"
  mkdir -p "$ROOT/logs"
  configure_logrotate
  pm2 describe "$APP" >/dev/null 2>&1 && { say "Already running — use 'restart'."; exit 0; }
  if [ "$mode" = "live" ]; then
    grep -qE '^BOT_PRIVATE_KEY=0x[0-9a-fA-F]{64}' "$ROOT/.env" \
      || die "LIVE mode requested but BOT_PRIVATE_KEY not set in .env"
    say "Starting LIVE ⚠️  (real transactions!)"
    (cd "$ROOT/bot" && pm2 start ecosystem.config.cjs --only "$APP" --update-env -- --mode live)
  else
    say "Starting DEMO (no real transactions)."
    (cd "$ROOT/bot" && pm2 start ecosystem.config.cjs --only "$APP")
  fi
  pm2 save >/dev/null 2>&1 || true
  say "✅ $APP online. Logs: ./scripts/manage.sh logs"
}

cmd_stop() {
  need_pm2
  pm2 stop "$APP" >/dev/null 2>&1 && say "Stopped (process kept in pm2 list)." \
    || say "Nothing to stop."
}

cmd_restart() {
  need_pm2; ensure_dist
  pm2 restart "$APP" --update-env >/dev/null 2>&1 && say "Restarted." \
    || cmd_start "${1:-demo}"
}

cmd_logs() {
  need_pm2
  mkdir -p "$ROOT/logs"
  tail -n 200 -F "$ROOT/logs/bot-out.log" "$ROOT/logs/bot-err.log" 2>/dev/null \
    || pm2 logs "$APP" --lines 200
}

cmd_status() {
  need_pm2
  pm2 describe "$APP" 2>/dev/null \
    | grep -E 'status|restarts|uptime|memory|cpu|mode' \
    || say "$APP is not registered with pm2."
  say "RAM budget: node heap capped at 384MB (--max-old-space-size), pm2 kills >450MB RSS."
}

cmd_update() {
  need_pm2; need_env
  cd "$ROOT"
  say "Pulling latest from git…"
  git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)" \
    || die "git pull failed — resolve conflicts manually (do NOT force on a trading box)"
  say "Installing deps (npm ci, locked & reproducible)…"
  (cd bot && npm ci --no-audit --no-fund)
  say "Building TypeScript…"
  (cd bot && npm run build)
  if pm2 describe "$APP" >/dev/null 2>&1; then
    say "Restarting bot with new code…"
    pm2 restart "$APP" --update-env >/dev/null
  else
    say "Bot was not running — start it with: ./scripts/manage.sh start"
  fi
  say "✅ Update complete."
}

cmd_health() {
  need_env
  local rpc
  rpc="$(sed -n 's/^RPC_PRIMARY=//p' "$ROOT/.env" | head -n1 | tr -d '[:space:]')"
  say "Ping $rpc …"
  local t0 t1 dt
  t0=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s)
  curl -fsS --max-time 3 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$rpc" >/dev/null
  t1=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s)
  dt=$((t1 - t0))
  if [ "$dt" -gt 200 ]; then say "⚠️  ${dt}ms — above 200ms budget; bot will auto-switch RPCs."
  else say "✅ ${dt}ms"; fi
}

case "${1:-}" in
  start)   shift; cmd_start "${1:-demo}" ;;
  stop)    cmd_stop ;;
  restart) shift; cmd_restart "${1:-}" ;;
  logs)    cmd_logs ;;
  status)  cmd_status ;;
  demo)    cmd_start demo ;;
  live)    cmd_start live ;;
  update)  cmd_update ;;
  health)  cmd_health ;;
  *) cat <<EOF
manage.sh — flash-loan-arb lifecycle
  start [demo|live]   launch under pm2 (default demo)
  stop                graceful stop
  restart             rebuild-free restart with fresh env
  logs                follow rotated logs
  status              pm2 health + memory budget
  update              git pull -> npm ci -> build -> restart
  health              latency-check the primary RPC
EOF
     exit 1 ;;
esac
