# =============================================================================
# flash-loan-arb — zsh shortcuts.  Append this block to ~/.zshrc :
#   cat scripts/zshrc-aliases.sh >> ~/.zshrc && source ~/.zshrc
# (bash users: change ARB_ROOT path and append to ~/.bash_profile instead)
# =============================================================================

export ARB_ROOT="$HOME/flash-loan-arb"          # <- adjust if you cloned elsewhere

arb-start()   { "$ARB_ROOT/scripts/manage.sh" start demo; }
arb-live()    { "$ARB_ROOT/scripts/manage.sh" start live; }
arb-stop()    { "$ARB_ROOT/scripts/manage.sh" stop; }
arb-restart() { "$ARB_ROOT/scripts/manage.sh" restart; }
arb-logs()    { "$ARB_ROOT/scripts/manage.sh" logs; }
arb-status()  { "$ARB_ROOT/scripts/manage.sh" status; }
arb-health()  { "$ARB_ROOT/scripts/manage.sh" health; }
arb-update()  { "$ARB_ROOT/scripts/manage.sh" update; }
arb-deploy()  { "$ARB_ROOT/scripts/deploy.sh"; }
arb-sweep()   { "$ARB_ROOT/scripts/sweep_profit.sh" "$@"; }      # arb-sweep --dry-run
arb-cd()      { cd "$ARB_ROOT" && ll || ls -la; }

# PM2 one-liners
alias arb-pm2='pm2 monit'
alias arb-save='pm2 save'

# Housekeeping for the 128/256GB SSD on the 2017 MBA
arb-clean() {
  echo "==> clearing forge + ts caches (safe, rebuilt on next run)"
  rm -rf "$ARB_ROOT/contracts/out" "$ARB_ROOT/contracts/cache" "$ARB_ROOT/bot/.tsbuildinfo"
}
