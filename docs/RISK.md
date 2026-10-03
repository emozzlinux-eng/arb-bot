# Risk & Edge Cases (read before LIVE)

## 1. Profit-sweep accounting assumes a single profit token
`sweepProfit(token, to)` transfers the **entire** balance of `token` held by the
contract. The "pure profit" invariant only holds while the contract receives no
other ERC20 flows into that same token (manual deposits, airdrops of USDC-like
tokens, or leftover mid-swap dust from a partially failed leg). If an external
transfer ever lands in the profit token, it WILL be swept to the cold wallet.
Mitigations baked in: contract never accepts those tokens via any public path;
dust-prone paths revert atomically (`minProfit` check reverts the whole tx);
`rescueFunds` exists for deliberate non-profit assets. Audit the token address
before changing `PROFIT_TOKEN`.

## 2. RPC failover can serve stale state mid-trade
The health monitor may switch endpoints between the `eth_call` simulation and
`sendTransaction`. Backup nodes lagging by 1–3 blocks mean your simulated
prices/profit were computed against a state that no longer mines — the classic
"succeeded in sim, reverted on-chain" case. That's why the on-chain `minProfit`
guard is mandatory (revert costs gas but never loss of principal), and why we
cap in-flight transactions at one. Never widen this without nonce management.

## 3. Leak vectors we explicitly closed (and ones to watch)
- **Log growth**: bot logs live in a fixed 200-entry ring; blessed keeps ≤40
  lines on screen. pm2 log files are the only unbounded growth — rotate with
  `pm2 install pm2-logrotate` (add to install checklist).
- **Timers/handles**: every `setInterval` is `unref()`d and cleared in
  `stop()`; grammy polling is aborted on shutdown. A future feature that adds
  listeners must also add removal — audit with `process._getActiveHandles()`
  after 24h soak.
- **WebSocket budget**: `WS_MAX_SUBSCRIPTIONS` caps viem WS clients; forgetting
  to call `rpc.closeWs()` after dropping a subscription slowly leaks socket FDs
  (visible as rising RSS + EMFILE on macOS ~256 FD default).

## General disclaimer
Flash-loan arbitrage is adversarial MEV territory: sandwiched transactions,
stolen quotes, reorged routes, and exchange depegging are all live risks. Run
DEMO for ≥72h, then tiny-size LIVE, and keep the hot wallet funded with gas for
exactly one transaction — nothing more can be lost than gas if you follow the
safety model in README.
