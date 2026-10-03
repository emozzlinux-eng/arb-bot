#!/usr/bin/env bash
# =============================================================================
# sweep_profit.sh — withdraw PURE PROFIT from the deployed FlashLoanArb to the
# cold wallet using Foundry `cast`. The contract holds NO gas capital (flash
# loan principal is repaid inside executeArb), so its resting token balance IS
# realized profit — this function can never drain bot working capital.
#
#   ./scripts/sweep_profit.sh                        # profitToken -> COLD_WALLET
#   ./scripts/sweep_profit.sh --token 0xUSDC --to 0xCold
#   ./scripts/sweep_profit.sh --dry-run              # preview only, no tx
#
# SECURITY: key is read from .env into the process env of cast only; nothing
# is echoed, prompted, or written to shell history.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ARB_ENV_FILE:-$ROOT/.env}"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

command -v cast >/dev/null 2>&1 || die "cast not found — run scripts/install.sh"
[ -f "$ENV_FILE" ] || die ".env missing at $ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n1 | sed 's/[[:space:]]*#.*$//' | tr -d '[:space:]'; }

CONTRACT="$(get_env CONTRACT_ADDRESS)"
RPC_URL="$(get_env RPC_PRIMARY)"
PK="$(get_env BOT_PRIVATE_KEY)"
DEFAULT_TOKEN="$(get_env PROFIT_TOKEN)"
DEFAULT_TO="$(get_env COLD_WALLET)"

TOKEN="${DEFAULT_TOKEN}"
TO="${DEFAULT_TO}"
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --token)   TOKEN="$2"; shift 2 ;;
    --to)      TO="$2"; shift 2 ;;
    --contract) CONTRACT="$2"; shift 2 ;;
    --rpc)     RPC_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) die "unknown flag: $1 (see header comment)" ;;
  esac
done

[[ "$CONTRACT" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "CONTRACT_ADDRESS invalid/empty — deploy first (scripts/deploy.sh)"
[[ "$TOKEN"    =~ ^0x[0-9a-fA-F]{40}$ ]] || die "--token must be a 0x address"
[[ "$TO"       =~ ^0x[0-9a-fA-F]{40}$ ]] || die "--to must be a 0x address"
[ "$TO" != "0x0000000000000000000000000000000000000000" ] || die "refusing to sweep to zero address"
[ "$TO" != "$CONTRACT" ] || die "refusing to sweep back into the contract itself"

DECIMALS="$(cast call "$TOKEN" 'decimals()(uint8)' --rpc-url "$RPC_URL")"
BAL="$(cast call "$CONTRACT" 'balanceOf(address)(uint256)' "$CONTRACT" --rpc-url "$RPC_URL")"
HUMAN="$(cast to-decimals "$BAL" --units "$((10 ** DECIMALS))" 2>/dev/null || echo "$BAL")"

say "Contract : $CONTRACT"
say "Token    : $TOKEN (dec=$DECIMALS)"
say "To       : $TO"
say "Balance  : $HUMAN (raw $BAL)"

if [ "$BAL" = "0" ]; then
  say "Nothing to sweep — contract balance is zero."
  exit 0
fi

$DRY_RUN && { say "Dry run — would call sweepProfit(token, to). No transaction sent."; exit 0; }

# Only LIVE sweeps need the owner key (sweepProfit is onlyOwner).
[ -n "$PK" ] || die "BOT_PRIVATE_KEY empty in .env — cannot sign sweep tx"

say "Broadcasting sweepProfit()…"
# Key passed via env (never argv) so it stays out of `ps` listings.
# --private-key-env-variables tells cast to READ THE NAME OF AN ENV VAR,
# not a raw key; stderr scrubbed as belt-and-braces against stray logging.
if ! SWEEP_OUT="$(PRIVATE_KEY="$PK" cast send "$CONTRACT" \
  'sweepProfit(address,address)' "$TOKEN" "$TO" \
  --rpc-url "$RPC_URL" \
  --private-key-env-variables 2>&1)"; then
  printf '%s\n' "$SWEEP_OUT" | grep -viE 'private_key|0x[0-9a-f]{64}' >&2 || true
  die "sweep transaction failed (see above)"
fi
printf '%s\n' "$SWEEP_OUT" | grep -iE 'transactionHash|blockNumber|status' || true

say "✅ Sweep sent. Verify:"
say "   cast call $CONTRACT 'balanceOf(address)(uint256)' $CONTRACT --rpc-url $RPC_URL   # should be ~0"
say "   And check your cold wallet on https://basescan.org/testnet"
