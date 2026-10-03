#!/usr/bin/env bash
# =============================================================================
# install.sh — one-shot bootstrap for macOS (2017 MacBook Air friendly).
# Idempotent: safe to re-run. No sudo unless Foundry needs it.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m WARN:\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

# --- 1. Homebrew ------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  say "Homebrew not found."
  die "Install Homebrew first:  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
fi

# --- 2. Node.js via nvm ------------------------------------------------------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  say "Installing nvm…"
  brew install nvm
  mkdir -p "$NVM_DIR"
  warn 'Add nvm sourcing to your shell profile (install.sh appends it in step 6).'
fi
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if command -v nvm >/dev/null 2>&1; then
  if ! nvm ls 2>/dev/null | grep -qE 'v(20|22)\.'; then
    say "Installing Node LTS v20 (lighter than v22 on old cores)…"
    nvm install 20
    nvm alias default 20
  fi
  nvm use default >/dev/null
fi
command -v node >/dev/null || die "node missing after nvm setup"
say "node $(node --version) / npm $(npm --version)"

# --- 3. Foundry --------------------------------------------------------------
if ! command -v forge >/dev/null 2>&1; then
  say "Installing Foundry (curl installer, no sudo)…"
  curl -L https://foundry.paradigm.xyz | bash
  # shellcheck disable=SC1091
  export PATH="$HOME/.foundry/bin:$PATH"
  [ -x "$HOME/.foundry/bin/foundryup" ] && "$HOME/.foundry/bin/foundryup"
fi
forge --version | head -1 || die "forge missing after install"

# --- 4. pm2 (process manager) -------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  say "Installing pm2…"
  npm install -g pm2
fi

# --- 5. Project deps ----------------------------------------------------------
say "npm ci in bot/ (deterministic, faster than install on cold cache)…"
cd "$ROOT/bot"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

say "Building TypeScript → dist/ …"
npm run build || die "build failed"

say "Compiling Solidity contracts…"
cd "$ROOT/contracts"
forge build --sizes

# --- 6. .env from template ----------------------------------------------------
cd "$ROOT"
if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env — EDIT IT before LIVE mode (BOT_PRIVATE_KEY, COLD_WALLET, TELEGRAM_*)."
else
  warn ".env already exists — leaving untouched."
fi

# --- 7. Shell aliases ---------------------------------------------------------
PROFILE="$HOME/.zshrc"
[ -n "${BASH_VERSION:-}" ] && [ "$(basename "$SHELL")" = "bash" ] && PROFILE="$HOME/.bash_profile"
if ! grep -q "# >>> flash-loan-arb aliases >>>" "$PROFILE" 2>/dev/null; then
  say "Appending arb-* aliases to $PROFILE"
  cat >> "$PROFILE" <<EOF

# >>> flash-loan-arb aliases >>>
alias arb-start='cd $ROOT && ./scripts/start.sh'
alias arb-stop='cd $ROOT && ./scripts/stop.sh'
alias arb-logs='pm2 logs flash-loan-arb --lines 100'
alias arb-restart='cd $ROOT && ./scripts/stop.sh; ./scripts/start.sh'
alias arb-demo='cd $ROOT/bot && npm run demo'
alias arb-live='ARB_MODE=live cd $ROOT && ./scripts/start.sh'
alias arb-update='cd $ROOT && ./scripts/update.sh'
alias arb-upgrade='cd $ROOT && ./scripts/upgrade.sh'
alias arb-status='pm2 status flash-loan-arb'
alias arb-deploy='cd $ROOT/contracts && source ../.env 2>/dev/null; forge script script/Deploy.s.sol:DeployScript --rpc-url "\${RPC_PRIMARY:-https://polygon-bor-rpc.publicnode.com}" --broadcast -vvv'
# <<< flash-loan-arb aliases <<<
EOF
  warn "Open a new terminal (or 'source $PROFILE') for aliases to take effect."
fi

say "✅ Install complete."
echo   "Next steps:"
echo   "  1. Edit $ROOT/.env"
echo   "  2. source $PROFILE"
echo   "  3. arb-start          # DEMO mode by default"
