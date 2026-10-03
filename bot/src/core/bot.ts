/**
 * bot.ts — the orchestrator. Owns lifecycle, PnL ledger, and mode switching.
 *
 * Memory strategy:
 *  - Stats are a single mutable object read by TUI/Telegram (no per-tick clones).
 *  - Log lines go into a FIXED-LENGTH ring (200 entries) — an unbounded log
 *    array is the #1 silent leak in long-running Node bots.
 *  - setInterval/unref everywhere so a stopped bot can never keep the loop alive.
 */
import { RpcManager } from './rpcManager.js';
import { GasOracle } from './gasOracle.js';
import { Scanner, initScanner, getVerifiedChainId } from './scanner.js';
import { Executor } from './executor.js';
import { getConfig } from './config.js';
import type { BotStats } from './types.js';

const CFG = getConfig();          // P0-1: validated singleton (was side-effect import)
const LOG_RING = 200;

export class Bot {
  readonly rpc: RpcManager;
  readonly gas: GasOracle;
  readonly scanner: Scanner;
  readonly executor: Executor;
  /** P0-1/P0-2: true once chain handshake + wallet init pass (read by /status). */
  scannerReady = false;

  /** Ring buffer of log strings — overwrites oldest first, zero allocations after boot. */
  readonly logs: string[] = new Array(LOG_RING).fill('');
  private logIdx = 0;

  stats: BotStats = {
    mode: CFG.mode, trading: true, activePairs: CFG.pairs.length,
    blocksSeen: 0, opportunities: 0, tradesExecuted: 0, tradesSkipped: 0,
    totalProfitUsd: 0, gasSpentUsd: 0, ramMb: 0,
    rpc: { url: CFG.rpcPrimary, latencyMs: 0, state: 'healthy', failures: 0 },
    uptimeSec: 0,
  };

  private t0 = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private sweeping = false;

  constructor() {
    this.rpc = new RpcManager({
      primary: CFG.rpcPrimary, backups: [...CFG.rpcBackups],
      thresholdMs: CFG.rpcMaxLatencyMs, maxWs: CFG.wsMaxSubscriptions,
    });
    this.gas = new GasOracle(this.rpc, {
      priorityCapGwei: CFG.priorityFeeCapGwei, maxFeeGwei: CFG.maxFeeGwei,
    });
    this.scanner = new Scanner(this.rpc, this.gas);
    this.executor = new Executor(this.rpc, this.gas);

    // Wire event callbacks → ring log (bound `this` once, no closures per event).
    const log = (m: string) => this.log(m);
    this.rpc.onEvent = log;
    this.scanner.onLog = log;
    this.executor.onLog = log;
  }

  log(msg: string): void {
    this.logs[this.logIdx] = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    this.logIdx = (this.logIdx + 1) % LOG_RING;
  }

  recentLogs(n = 12): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const idx = (this.logIdx - 1 - i + LOG_RING * 2) % LOG_RING;
      if (this.logs[idx]) out.push(this.logs[idx]);
    }
    return out;
  }

  // --------------------------------------------------------------- lifecycle
  /**
   * P0-1: async init — performs the RPC chain handshake BEFORE any trading
   * machinery is allowed to tick. Exits on mismatch (inside initScanner).
   */
  async init(): Promise<void> {
    await initScanner(this.rpc);                       // chainId handshake, exit(1) on mismatch
    this.executor.initExecutor();                      // wallet bound to VERIFIED chain only
    this.scannerReady = true;
    this.log(`[bot] chain verified: ${getVerifiedChainId()} — executor ready`);
  }

  start(): void {
    if (!this.scannerReady) {
      this.log('[bot] FATAL: start() before init() — refusing');
      process.exit(1);
    }
    this.log(`[bot] starting in ${this.stats.mode.toUpperCase()} mode — pairs: ${CFG.pairs.map((p: { tokenA: string; tokenB: string }) => `${p.tokenA}/${p.tokenB}`).join(', ')}`);
    this.rpc.start(10_000);
    this.scanner.start(2_000);

    // Main decision loop: 2s cadence. One pass = scan → gate → execute.
    const mainTimer = setInterval(() => void this.tick(), 2_000);
    mainTimer.unref?.();
    this.timers.push(mainTimer);

    // Housekeeping timer: RAM gauge + auto-sweep + heap watchdog.
    const house = setInterval(() => void this.housekeeping(), 15_000);
    house.unref?.();
    this.timers.push(house);
  }

  stop(reason = 'manual'): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.scanner.stop();
    this.rpc.stop();
    this.trading = false;
    this.log(`[bot] STOPPED (${reason})`);
  }

  set trading(on: boolean) { this.stats.trading = on; }
  get trading(): boolean { return this.stats.trading; }

  /**
   * P0-2: hot-swap removed. Mode changes go through Telegram /set_mode →
   * atomicEnvUpdate + pm2 restart. This setter only renames the label for
   * TUI display while a restart is pending; trading behaviour is unchanged.
   */
  setModeLabel(mode: 'demo' | 'live'): void {
    this.stats.mode = mode;
    this.log(`[bot] mode LABEL → ${mode.toUpperCase()} (restart required — /set_mode does it)`);
  }

  // ------------------------------------------------------------------ tick
  private async tick(): Promise<void> {
    if (!this.stats.trading) return;
    try {
      const opps = await this.scanner.scanOnce();
      this.stats.blocksSeen++;
      if (!opps.length) return;
      this.stats.opportunities += opps.length;

      const best = opps[0];
      this.log(`[tick] ${best.pair} spread=${best.quote.spreadBps.toFixed(1)}bps estNet=$${best.expectedProfitUsd.toFixed(2)}`);

      const res = await this.executor.execute(best);
      if (res.success) {                                 // P0-3: TradeResult field names
        this.stats.tradesExecuted++;
        this.stats.totalProfitUsd += res.profitUsd;      // per-trade delta, not cumulative balance
        this.stats.gasSpentUsd += res.gasCostUsd;        // actual paid (receipt × dynamic price)
      } else {
        this.stats.tradesSkipped++;
        if (res.reason) this.log(`[tick] skipped: ${res.reason}`);
      }
    } catch (e) {
      this.log(`[tick] error: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // ------------------------------------------------------------ housekeeping
  private async housekeeping(): Promise<void> {
    const mu = process.memoryUsage();
    this.stats.ramMb = Math.round(mu.heapUsed / 1024 / 1024);
    this.stats.uptimeSec = Math.floor((Date.now() - this.t0) / 1000);
    this.stats.rpc = this.rpc.info();

    // Heap watchdog: if we creep past the soft limit, ask V8 for a major GC
    // hint (when flag enabled) and drop any transient caches. NEVER crash-loop.
    if (mu.heapUsed / 1024 / 1024 > CFG.heapSoftLimitMb) {
      this.log(`[mem] heap ${this.stats.ramMb}MB > soft limit ${CFG.heapSoftLimitMb}MB — trimming caches`);
      (global as { gc?: () => void }).gc?.();          // only with --expose-gc
    }

    // Auto-sweep when contract profit crosses threshold (batching saves gas).
    if (!this.sweeping && this.stats.trading) {
      const bal = await this.executor.profitBalance();
      if (bal >= CFG.sweepThresholdUsd) {
        this.sweeping = true;
        try {
          const r = await this.executor.sweep();
          if (r.success) this.log(`[sweep] moved $${r.profitUsd.toFixed(2)} to cold wallet`);
          else this.log(`[sweep] skipped: ${r.reason}`);
        } finally { this.sweeping = false; }
      }
    }
  }

  /** Kill-switch used by Telegram: halt, brick route, sweep everything home. */
  async killSwitch(): Promise<string> {
    this.stop('KILL SWITCH');
    await this.executor.emergencyStop();               // P0-2: revokeAllowances + brick route
    const r = await this.executor.sweep();             // withdraw ALL contract profit
    const msg = r.success
      ? `⛔ KILL SWITCH executed. Allowances revoked, route bricked. $${r.profitUsd.toFixed(2)} swept to cold wallet.`
      : `⛔ KILL SWITCH halted trading & bricked route. Sweep issue: ${r.reason}`;
    this.log(msg);
    return msg;
  }
}
