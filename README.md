# flash-loan-arb

Production-grade **Aave V3 flash-loan arbitrage system** (Uniswap V3 / SushiSwap
two-leg) with a Node.js bot core, blessed TUI, Telegram remote control, and
pm2 automation — engineered to run on a **2017 MacBook Air (i5, 8GB RAM)**.

```
┌──────────────┐   JSON-RPC (keep-alive pool)   ┌─────────────────┐
│  TS Bot Core │◄──────────────────────────────►│  RPC Manager     │  ← EWMA latency, auto-failover >200ms
│  (viem ESM)  │                                └─────────────────┘
│              │   scan → gate(minProfit,gas) → execute           ┌─────────────────┐
│              │─────────────────────────────────────────────────►│  FlashLoanArb    │ ← Aave V3 flashLoanSimple
└──────┬───────┘                                                  │  UniV3 leg A/B   │   2-leg swap, repay+premium
       │                                                        └────────┬────────┘
       │ pm2 (fork, 384MB heap cap, max_memory_restart 450M)             │ profit accumulates in contract
       ▼                                                                ▼
┌──────────────┐   /status /kill_switch                     sweepProfit(token, coldWallet)
│ blessed TUI  │   /start_bot /stop_bot /set_mode                    💰 COLD WALLET
│ grammy TG    │                                              (gas capital stays in bot EOA)
└──────────────┘
```

## Why this fits a 2017 MBA

| Constraint | Mitigation |
|---|---|
| 8GB RAM, no headroom | `--max-old-space-size=384` + pm2 `max_memory_restart: 450M`; viem instead of ethers (~⅓ module weight); blessed instead of ink (no React/yoga); zero-dep Solidity (no OZ clone). |
| Dual-core i5, thermal throttling | Bounded scan concurrency (`MAX_CONCURRENT_SCANS=4` worker window, never unbounded `Promise.all`); skip-if-busy scans; Telegram long-polling (no webhook server); TUI repaints once/sec; all timers `unref()`. |
| Memory leaks kill 24/7 bots | Fixed log ring (200 entries), mutated-in-place quote objects (identity-stable), Float64Array latency rings, memoized decimals cache, explicit `stop()` clearing every interval, heap watchdog with GC hint. |
| Slow SSD / cold builds | `npm ci` lockfile installs; Foundry incremental cache; contracts compile with no remappings to fetch. |

## Quick start

```bash
git clone <your-repo> flash-loan-arb && cd flash-loan-arb
./scripts/install.sh                 # nvm→node20, foundry, pm2, npm ci, tsc, forge build, .env, aliases
$EDITOR .env                         # DEMO_MODE=true first!
source ~/.zshrc
arb-start                            # demo under pm2
arb-logs                             # tail
ARB_MODE=live arb-start              # only after funding hot wallet & deploying contract
```

Deploy the contract:

```bash
cd contracts
export RPC_URL=$RPC_PRIMARY PRIVATE_KEY=0x... AAVE_POOL=0x794a... COLD_WALLET=0x... \
       PROFIT_TOKEN=0x3c49... BORROW_TOKEN=0x3c49... MIN_PROFIT_WEI=5000000 \
       POOL_A=0x45cA... POOL_B=0x9AD4... POOL_A_ZFO=true POOL_B_ZFO=false
forge script script/Deploy.s.sol:DeployScript --rpc-url $RPC_URL --broadcast -vvv
```

## Components

- `contracts/src/FlashLoanArb.sol` — Aave V3 `flashLoanSimple` receiver, two-leg
  UniV3-style swaps, strict `minProfit` revert, `sweepProfit`, `rescueFunds`,
  `emergencyStop`, hand-rolled SafeERC20 + custom errors.
- `bot/src/core/` — `rpcManager` (health monitor + failover), `gasOracle`
  (EIP-1559 dynamic fees with hard ceilings), `scanner` (multi-pair bounded
  concurrency), `executor` (simulate-gate → send → receipt → balance-delta PnL),
  `bot` (orchestrator, kill-switch, auto-sweep).
- `bot/src/ui/` — `tui.ts` (blessed dashboard), `telegram.ts` (grammy commands).
- `scripts/` — install/update/upgrade/start/stop + `arb-*` zsh aliases.

## Telegram commands

`/status` `/start_bot` `/stop_bot` `/kill_switch` `/set_mode demo|live` `/sweep` `/help`
— all gated by `TELEGRAM_CHAT_ID` allow-list.

## Safety model

1. Off-chain gate: spread must clear gas + 0.05% Aave premium + `MIN_PROFIT_USD`.
2. `eth_call` simulation before every broadcast (revert costs $0 off-chain).
3. On-chain gate: contract reverts whole tx unless realized profit ≥ `minProfit`.
4. Single in-flight execution lock (nonce races can't stack flash loans).
5. Kill switch = halt loop → `emergencyStop()` bricks route on-chain → `sweepProfit` → cold wallet.

Read `docs/RISK.md` before running LIVE.
