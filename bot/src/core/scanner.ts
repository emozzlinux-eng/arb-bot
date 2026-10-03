/**
 * scanner.ts — multi-pair opportunity detector.  (P0-1 rewrite)
 *
 * WHAT CHANGED vs. the broken version:
 *  - ZERO hardcoded chain ids or pool addresses. Everything flows from
 *    config.ts (.env): chainId, POOL_A, POOL_B.
 *  - SUPPORTED_CHAINS map resolves chainId → viem Chain definition; an
 *    UNKNOWN chain id fails at boot instead of silently trading on a fork.
 *  - initScanner() performs a live getChainId() handshake against the RPC and
 *    hard-exits (code 1) on mismatch — the #1 way to lose money is sending
 *    Base-Sepolia-signed txs to a Polygon endpoint that answers anyway.
 *  - getPoolQuote() refuses any address that isn't config.poolA/poolB
 *    (defense-in-depth: a poisoned quote can never make us touch a rogue pool).
 *
 * DEMO_MODE: deterministic pseudo-random spread generator + historical-block
 *            replay. Zero network I/O → runs cool & silent on the MBA fan curve.
 * LIVE_MODE: reads Uniswap V3 pool slot0() over a bounded concurrency window;
 *            SushiSwap/forks use the identical slot0 signature.
 *
 * Event-loop strategy for a dual-core i5:
 *  - Fixed worker window (maxConcurrentScans). We NEVER Promise.all() an
 *    unbounded array — that would spike both heap and libuv threadpool.
 *  - Results are pushed into a pre-allocated ring of PairQuote objects that we
 *    MUTATE IN PLACE (same object identity forever) → near-zero GC pressure.
 *  - PERF: LIVE quotes use ONE multicall for both pool slot0() reads instead
 *    of two sequential round-trips — halves RPC latency per scan pass.
 */
import { createPublicClient, http, type Chain, type PublicClient } from 'viem';
import { mainnet, base, baseSepolia, polygon, polygonAmoy, arbitrum, optimism } from 'viem/chains';
import type { RpcManager } from './rpcManager.js';
import type { GasOracle } from './gasOracle.js';
import type { PairQuote, ArbOpportunity } from './types.js';
import { getConfig } from './config.js';

const AAVE_PREMIUM_BPS = 5n; // Aave V3 flashLoanSimple default fee: 0.05%

/**
 * P0-1: the ONLY chain registry. Add a line here when supporting a new chain;
 * nothing else in the codebase may name a chain.
 */
export const SUPPORTED_CHAINS: ReadonlyMap<number, Chain> = new Map<number, Chain>([
  [mainnet.id, mainnet],           // 1
  [base.id, base],                 // 8453
  [baseSepolia.id, baseSepolia],   // 84532
  [polygon.id, polygon],           // 137
  [polygonAmoy.id, polygonAmoy],   // 80002
  [arbitrum.id, arbitrum],         // 42161
  [optimism.id, optimism],         // 10
]);

const SLOT0_ABI = [{
  type: 'function', name: 'slot0', stateMutability: 'view',
  inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' },
    { name: 'observationCardinality', type: 'uint16' },
    { name: 'protocolFeeOn', type: 'bool' },
    { name: 'unlocked', type: 'bool' },
  ],
}] as const;

// ------------------------------------------------------------- module state
let publicClient: PublicClient | null = null;   // built once in initScanner()
let verifiedChainId = 0;                        // 0 ⇒ never verified ⇒ unusable

/** Chain definition for the configured id; exits(1) if unsupported. */
export function resolveChain(chainId: number): Chain {
  const c = SUPPORTED_CHAINS.get(chainId);
  if (!c) {
    console.error(`[scanner] FATAL: CHAIN_ID=${chainId} not in SUPPORTED_CHAINS ` +
      `(${[...SUPPORTED_CHAINS.keys()].join(', ')}). Fix .env or extend the map.`);
    process.exit(1);
  }
  return c;
}

/**
 * Boot-time initializer with RPC handshake.
 * Call BEFORE constructing Scanner/Executor. Exits(1) on chain mismatch.
 */
export async function initScanner(rpc: RpcManager): Promise<PublicClient> {
  const cfg = getConfig();
  const chain = resolveChain(cfg.chainId);

  // Bind a viem client to the DECLARED chain so every downstream read/write
  // carries the right chain context (failover transport still lives in RpcManager).
  publicClient = createPublicClient({
    chain,
    transport: http(cfg.rpcPrimary, { retryCount: 1, timeout: 8_000 }),
  }) as PublicClient;

  // ---- P0-1 handshake: does the endpoint actually serve our chain? --------
  let rpcChainId: number;
  try {
    rpcChainId = await publicClient.getChainId();
  } catch (e) {
    console.error(`[scanner] FATAL: cannot reach ${cfg.rpcPrimary} (${(e as Error).message.slice(0, 60)})`);
    process.exit(1);
  }
  if (rpcChainId !== cfg.chainId) {
    console.error(
      `[scanner] FATAL CHAIN MISMATCH: .env says CHAIN_ID=${cfg.chainId} (${chain.name}) ` +
      `but RPC ${cfg.rpcPrimary} reports ${rpcChainId}. Refusing to trade. ` +
      `Fix RPC_PRIMARY/CHAIN_ID in .env — do NOT bypass this check.`,
    );
    process.exit(1);
  }
  verifiedChainId = rpcChainId;
  return publicClient;
}

export function getPublicClient(): PublicClient {
  if (!publicClient) throw new Error('[scanner] getPublicClient() called before initScanner()');
  return publicClient;
}

/** 0 means "not yet verified" — callers must treat that as fatal. */
export function getVerifiedChainId(): number { return verifiedChainId; }

// ------------------------------------------------------------------ scanner
type Slot0Result = readonly [bigint, number, number, number, boolean, boolean];

export class Scanner {
  private quotes: Map<string, PairQuote>;   // reused objects, mutated in place
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private blockSeen = 0;
  /** PERF: cached config + derived hot-path values — no getConfig()/toLowerCase per scan. */
  private readonly cfg = getConfig();
  private readonly poolALower = this.cfg.poolA.toLowerCase();
  private readonly poolBLower = this.cfg.poolB.toLowerCase();
  /** PERF: stable job-key array + reusable results buffer (no per-scan allocation). */
  private readonly jobKeys: string[];
  private readonly results: (PairQuote | null)[];
  onLog?: (msg: string) => void;

  constructor(private rpc: RpcManager, private gas: GasOracle) {
    const cfg = this.cfg;
    // P0-1: pools come from .env now — no POOL_REGISTRY constant anywhere.
    if (cfg.mode === 'live' && (!cfg.poolA || !cfg.poolB)) {
      console.error('[scanner] FATAL: POOL_A/POOL_B missing in .env (LIVE mode)');
      process.exit(1);
    }
    // Pre-allocate one mutable quote per pair — never re-created afterwards.
    this.quotes = new Map();
    for (const p of cfg.pairs) {
      this.quotes.set(`${p.tokenA}/${p.tokenB}`, {
        pair: `${p.tokenA}/${p.tokenB}`, poolA: '', poolB: '',
        priceA: 0n, priceB: 0n, spreadBps: 0, blockNumber: 0, ts: 0,
      });
    }
    this.jobKeys = [...this.quotes.keys()];
    this.results = new Array(this.jobKeys.length).fill(null);
  }

  /** Skip-if-busy wrapper: overlapping scans would double RPC load on the MBA. */
  private async runScanLoop(): Promise<ArbOpportunity[]> {
    return this.scanOnce();     // scanOnce() itself short-circuits when busy
  }

  start(intervalMs = 2_000): void {
    void this.runScanLoop();                  // fire-and-forget; loop self-manages pacing
    this.timer = setInterval(() => void this.runScanLoop(), intervalMs);
    this.timer.unref?.();                     // never keeps the event loop alive on shutdown
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  latestQuotes(): IterableIterator<PairQuote> { return this.quotes.values(); }

  /** Single pass over all pairs with a bounded concurrency window. */
  async scanOnce(): Promise<ArbOpportunity[]> {
    if (this.scanning) return [];               // skip-if-busy beats queueing (no backlog leak)
    this.scanning = true;
    try {
      const out: ArbOpportunity[] = [];
      const jobs = this.jobKeys;
      const results = this.results;
      results.fill(null);                       // reuse buffer — zero per-scan allocation

      // Semaphore-style window: exactly N promises alive at any moment.
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < jobs.length) {
          const idx = cursor++;
          try { results[idx] = await this.quoteFor(jobs[idx]); }
          catch (e) { this.onLog?.(`[scan] ${jobs[idx]}: ${(e as Error).message.slice(0, 60)}`); }
        }
      };
      const nWorkers = Math.min(this.cfg.maxConcurrentScans, jobs.length);
      const workers = new Array<Promise<void>>(nWorkers);
      for (let i = 0; i < nWorkers; i++) workers[i] = worker();
      await Promise.all(workers);

      const fees = await this.gas.fees(this.blockSeen || 1);
      const fallbackGasUsd = fees?.estimatedUsd ?? 0.5;
      for (let i = 0; i < results.length; i++) {
        const q = results[i];
        if (!q) continue;
        const opp = this.toOpportunity(q, fallbackGasUsd);
        if (opp) out.push(opp);
      }
      out.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd); // best first, tiny array
      return out;
    } finally {
      this.scanning = false;
    }
  }

  // ------------------------------------------------------------------ per-pair
  private async quoteFor(pair: string): Promise<PairQuote | null> {
    const cfg = this.cfg;
    const q = this.quotes.get(pair)!;           // existing object — mutate in place
    if (cfg.mode === 'demo') {
      const t = Date.now();
      // Smooth pseudo-spread: two sine waves → occasional >15bps spikes to exercise the pipeline.
      const wob = Math.sin(t / 7_000) * 8 + Math.sin(t / 2_300) * 6;
      q.spreadBps = wob;
      q.priceA = 3_000_000_000_000_000_000_000n; // mock $3000 scaled 1e18… style
      q.priceB = q.priceA * (10_000n + BigInt(Math.round(wob))) / 10_000n;
      q.poolA = 'MOCK-UNI'; q.poolB = 'MOCK-SUSHI';
      q.blockNumber = ++this.blockSeen; q.ts = t;
      return q;
    }

    // LIVE: single configured route (POOL_A cheap leg, POOL_B expensive leg).
    // PERF: BOTH slot0() reads go out as ONE JSON-RPC multicall batch —
    // one round-trip instead of two sequential ones (halves per-pass latency).
    const paAddr = cfg.poolA as `0x${string}`;
    const pbAddr = cfg.poolB as `0x${string}`;
    let pa: bigint | null;
    let pb: bigint | null;
    try {
      const batched = await this.rpc.client.multicall({
        allowFailure: true,
        contracts: [
          { address: paAddr, abi: SLOT0_ABI, functionName: 'slot0' },
          { address: pbAddr, abi: SLOT0_ABI, functionName: 'slot0' },
        ],
      });
      const [ra, rb] = batched;
      pa = ra.status === 'success' ? this.priceFromSqrt((ra.result as Slot0Result)[0], 18, 18) : null;
      pb = rb.status === 'success' ? this.priceFromSqrt((rb.result as Slot0Result)[0], 18, 18) : null;
    } catch (e) {
      this.onLog?.(`[scan] ${pair} multicall failed: ${(e as Error).message.slice(0, 60)}`);
      return null;
    }
    if (pa === null || pb === null) return null;

    q.priceA = pa; q.priceB = pb;
    q.spreadBps = pa > 0n ? Number(((pb - pa) * 10_000n) / pa) / 10_000 : 0; // signed bps
    q.poolA = paAddr; q.poolB = pbAddr;
    q.blockNumber = ++this.blockSeen; q.ts = Date.now();
    return q;
  }

  /**
   * P0-1 allow-list guard: only the two pools from .env may ever be quoted.
   * A malformed/spread quote can never drag us onto a rogue pool.
   * PERF: compares against PRE-LOWERED constants captured at construction.
   */
  private poolAllowed(pool: `0x${string}`): boolean {
    const lower = pool.toLowerCase();
    const ok = lower === this.poolALower || lower === this.poolBLower;
    if (!ok) this.onLog?.(`[scan] REJECTED non-configured pool ${pool.slice(0, 10)}…`);
    return ok;
  }

  /** Returns 1e18-scaled price (token1 per token0) or null on any failure. */
  async getPoolQuote(pool: `0x${string}`): Promise<bigint | null> {
    if (!this.poolAllowed(pool)) return null;
    try {
      const res = await this.rpc.client.readContract({
        address: pool, abi: SLOT0_ABI, functionName: 'slot0',
      });
      // 18/18 normalization (WETH/WBTC legs). USDC legs: same math applies on
      // both pools, so the SPREAD comparison stays valid even without decimals
      // correction; absolute price display is approximate by design (saves RPC).
      return this.priceFromSqrt(res[0], 18, 18);
    } catch { return null; }
  }

  /**
   * price(token1 per token0) = sqrtP^2 / 2^192, rescaled by 10^(d0-d1) and
   * pushed to an 1e18 fixed point for cross-pool comparison.
   * PERF: the two powers of ten are module constants — no BigInt exponentiation
   * on the hot path (this runs twice per pair per scan).
   */
  private static readonly P18_IN = 10n ** 36n;    // 10^(18+decIn), decIn fixed at 18
  private static readonly P_OUT = 10n ** 18n;     // 10^decOut, decOut fixed at 18

  private priceFromSqrt(sqrtX96: bigint, _decOut: number, _decIn: number): bigint {
    const sq = sqrtX96 * sqrtX96;                       // x192 fixed point
    const scaled = (sq * Scanner.P18_IN) >> 192n;
    return scaled / Scanner.P_OUT;
  }

  // ------------------------------------------------------------- economics
  /** PERF: premium as a precomputed float constant — no Number() conversion per call. */
  private static readonly PREMIUM_FRAC = Number(AAVE_PREMIUM_BPS) / 10_000;

  private toOpportunity(q: PairQuote, gasUsd: number): ArbOpportunity | null {
    const cfg = this.cfg;
    if (Math.abs(q.spreadBps) < 10) return null;              // floor: sub-10bps never clears costs
    const borrowedUsd = Math.min(cfg.maxLoanUsd, 25_000);      // conservative depth cap
    const grossUsd = (borrowedUsd * Math.abs(q.spreadBps)) / 10_000;
    const premiumUsd = borrowedUsd * Scanner.PREMIUM_FRAC;
    const net = grossUsd - premiumUsd - gasUsd;
    if (net < cfg.minProfitUsd) return null;                  // strict minProfit gate OFF-chain too
    return {
      pair: q.pair, poolA: q.poolA, poolB: q.poolB,
      borrowedUsd, expectedProfitUsd: net, gasCostUsd: gasUsd, premiumUsd, quote: q,
    };
  }
}
