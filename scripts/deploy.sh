#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy FlashLoanArb to Base Sepolia (chain 84532) via Foundry.
#
#   ./scripts/deploy.sh                 # uses RPC_PRIMARY + keys from .env
#   ./scripts/deploy.sh <rpc_url>       # override RPC for this run only
#
# SECURITY: secrets are read from .env into process env vars ONLY. They are
# never echoed, never written to a file, and never appear in your shell
# history (nothing is typed at the prompt).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ARB_ENV_FILE:-$ROOT/.env}"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
command -v forge >/dev/null 2>&1 || die "forge not found — run scripts/install.sh"
[ -f "$ENV_FILE" ] || die ".env missing at $ENV_FILE — cp .env.example .env && nano .env"
chmod 600 "$ENV_FILE" 2>/dev/null || true

# Load ONLY the variables we need (whitelist > blind `source` = no accidental
# leakage of unrelated vars, no code-exec surprises from a malformed .env).
load_env() {
  local key val
  key="$1"
  val="$(sed -n "s/^${key}=//p" "$ENV_FILE" | head -n1 | sed 's/[[:space:]]*#.*$//' | tr -d '[:space:]')"
  printf -v "DEPLOY_${key}" '%s' "${val:-}"
}

for k in RPC_PRIMARY BOT_PRIVATE_KEY COLD_WALLET AAVE_V3_POOL PROFIT_TOKEN \
         BORROW_TOKEN MIN_PROFIT_WEI POOL_A POOL_B POOL_A_ZFO POOL_B_ZFO CHAIN_ID; do
  load_env "$k"
done

RPC_URL="${1:-${DEPLOY_RPC_PRIMARY:-https://sepolia.base.org}}"

[ -n "$DEPLOY_BOT_PRIVATE_KEY" ] || die "BOT_PRIVATE_KEY empty in .env (needed to pay deployment gas)"
[[ "$DEPLOY_BOT_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "BOT_PRIVATE_KEY must be 0x + 64 hex chars"
[ -n "$DEPLOY_COLD_WALLET" ] && [ "$DEPLOY_COLD_WALLET" != "0x0000000000000000000000000000000000000000" ] \
  || die "COLD_WALLET not set — profits would be un-sweepable"

# Safety rails for testnet defaults
if [ "${DEPLOY_AAVE_V3_POOL:-0x0000000000000000000000000000000000000000}" = "0x0000000000000000000000000000000000000000" ]; then
  say "⚠️  AAVE_V3_POOL is zero-address. Contract will deploy but flash loans won't work until you set it."
fi

say "Chain ID : ${DEPLOY_CHAIN_ID:-84532} (expecting Base Sepolia)"
say "RPC      : $RPC_URL"
say "Deployer : $(cast wallet address --private-key "$DEPLOY_BOT_PRIVATE_KEY" 2>/dev/null || echo '<unknown>')"

# ---------------------------------------------------------------- build first
cd "$ROOT/contracts"
say "Compiling with forge…"
forge build --sizes || die "forge build failed"

# ---------------------------------------------------------------- deploy
say "Broadcasting deployment…"
# Constructor path form: contracts/script/Deploy.s.sol:DeployScript reads the
# same vars above via vm.env*, keeping the key out of argv (`ps` safe).
# NOTE: we pass values inline to THIS command only — no `export`, so the
# private key never lands in the persistent shell environment.
OUT="$(PRIVATE_KEY="$DEPLOY_BOT_PRIVATE_KEY" \
       AAVE_POOL="$DEPLOY_AAVE_V3_POOL" \
       COLD_WALLET="$DEPLOY_COLD_WALLET" \
       PROFIT_TOKEN="$DEPLOY_PROFIT_TOKEN" \
       BORROW_TOKEN="$DEPLOY_BORROW_TOKEN" \
       MIN_PROFIT_WEI="$DEPLOY_MIN_PROFIT_WEI" \
       POOL_A="$DEPLOY_POOL_A" \
       POOL_B="$DEPLOY_POOL_B" \
       POOL_A_ZFO="$DEPLOY_POOL_A_ZFO" \
       POOL_B_ZFO="$DEPLOY_POOL_B_ZFO" \
       forge script script/Deploy.s.sol:DeployScript \
        --rpc-url "$RPC_URL" \
        --broadcast \
        --slow 2>&1)" || { printf '%s\n' "$OUT" >&2; die "forge script failed"; }

# Extract deployed address from forge output (never prints secrets).
ADDR="$(printf '%s\n' "$OUT" | grep -oE 'FlashLoanArb deployed at: 0x[0-9a-fA-F]{40}' | grep -oE '0x[0-9a-fA-F]{40}' | tail -n1 || true)"
[ -n "$ADDR" ] || die "could not parse deployed address from forge output"

# ---------------------------------------------------------------- write back CONTRACT_ADDRESS
if grep -q '^CONTRACT_ADDRESS=' "$ENV_FILE"; then
  sed -i.bak "s/^CONTRACT_ADDRESS=.*/CONTRACT_ADDRESS=$ADDR/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
else
  printf 'CONTRACT_ADDRESS=%s\n' "$ADDR" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

say "✅ Deployed FlashLoanArb at $ADDR"
say "   CONTRACT_ADDRESS written to .env — restart the bot: ./scripts/manage.sh restart"
