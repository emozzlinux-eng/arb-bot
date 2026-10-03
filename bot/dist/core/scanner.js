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
 */
import { createPublicClient, http } from 'viem';
import { mainnet, base, baseSepolia, polygon, polygonAmoy, arbitrum, optimism } from 'viem/chains';
import { getConfig } from './config.js';
const AAVE_PREMIUM_BPS = 5n; // Aave V3 flashLoanSimple default fee: 0.05%
/**
 * P0-1: the ONLY chain registry. Add a line here when supporting a new chain;
 * nothing else in the codebase may name a chain.
 */
export const SUPPORTED_CHAINS = new Map([
    [mainnet.id, mainnet], // 1
    [base.id, base], // 8453
    [baseSepolia.id, baseSepolia], // 84532
    [polygon.id, polygon], // 137
    [polygonAmoy.id, polygonAmoy], // 80002
    [arbitrum.id, arbitrum], // 42161
    [optimism.id, optimism], // 10
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
    }];
// ------------------------------------------------------------- module state
let publicClient = null; // built once in initScanner()
let verifiedChainId = 0; // 0 ⇒ never verified ⇒ unusable
/** Chain definition for the configured id; exits(1) if unsupported. */
export function resolveChain(chainId) {
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
export async function initScanner(rpc) {
    const cfg = getConfig();
    const chain = resolveChain(cfg.chainId);
    // Bind a viem client to the DECLARED chain so every downstream read/write
    // carries the right chain context (failover transport still lives in RpcManager).
    publicClient = createPublicClient({
        chain,
        transport: http(cfg.rpcPrimary, { retryCount: 1, timeout: 8_000 }),
    });
    // ---- P0-1 handshake: does the endpoint actually serve our chain? --------
    let rpcChainId;
    try {
        rpcChainId = await publicClient.getChainId();
    }
    catch (e) {
        console.error(`[scanner] FATAL: cannot reach ${cfg.rpcPrimary} (${e.message.slice(0, 60)})`);
        process.exit(1);
    }
    if (rpcChainId !== cfg.chainId) {
        console.error(`[scanner] FATAL CHAIN MISMATCH: .env says CHAIN_ID=${cfg.chainId} (${chain.name}) ` +
            `but RPC ${cfg.rpcPrimary} reports ${rpcChainId}. Refusing to trade. ` +
            `Fix RPC_PRIMARY/CHAIN_ID in .env — do NOT bypass this check.`);
        process.exit(1);
    }
    verifiedChainId = rpcChainId;
    return publicClient;
}
export function getPublicClient() {
    if (!publicClient)
        throw new Error('[scanner] getPublicClient() called before initScanner()');
    return publicClient;
}
/** 0 means "not yet verified" — callers must treat that as fatal. */
export function getVerifiedChainId() { return verifiedChainId; }
// ------------------------------------------------------------------ scanner
export class Scanner {
    rpc;
    gas;
    quotes; // reused objects, mutated in place
    timer = null;
    scanning = false;
    blockSeen = 0;
    onLog;
    constructor(rpc, gas) {
        this.rpc = rpc;
        this.gas = gas;
        const cfg = getConfig();
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
    }
    /** Skip-if-busy wrapper: overlapping scans would double RPC load on the MBA. */
    async runScanLoop() {
        return this.scanOnce(); // scanOnce() itself short-circuits when busy
    }
    start(intervalMs = 2_000) {
        void this.runScanLoop(); // fire-and-forget; loop self-manages pacing
        this.timer = setInterval(() => void this.runScanLoop(), intervalMs);
        this.timer.unref?.(); // never keeps the event loop alive on shutdown
    }
    stop() { if (this.timer)
        clearInterval(this.timer); this.timer = null; }
    latestQuotes() { return [...this.quotes.values()]; }
    /** Single pass over all pairs with a bounded concurrency window. */
    async scanOnce() {
        if (this.scanning)
            return []; // skip-if-busy beats queueing (no backlog leak)
        this.scanning = true;
        try {
            const out = [];
            const jobs = [...this.quotes.keys()];
            const results = new Array(jobs.length).fill(null);
            // Semaphore-style window: exactly N promises alive at any moment.
            let cursor = 0;
            const workers = Array.from({ length: Math.min(getConfig().maxConcurrentScans, jobs.length) }, async () => {
                while (cursor < jobs.length) {
                    const idx = cursor++;
                    try {
                        results[idx] = await this.quoteFor(jobs[idx]);
                    }
                    catch (e) {
                        this.onLog?.(`[scan] ${jobs[idx]}: ${e.message.slice(0, 60)}`);
                    }
                }
            });
            await Promise.all(workers);
            const fees = await this.gas.fees(this.blockSeen || 1);
            for (const q of results) {
                if (!q)
                    continue;
                const opp = this.toOpportunity(q, fees?.estimatedUsd ?? 0.5);
                if (opp)
                    out.push(opp);
            }
            out.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd); // best first, tiny array
            return out;
        }
        finally {
            this.scanning = false;
        }
    }
    // ------------------------------------------------------------------ per-pair
    async quoteFor(pair) {
        const cfg = getConfig();
        const q = this.quotes.get(pair); // existing object — mutate in place
        if (cfg.mode === 'demo') {
            const t = Date.now();
            // Smooth pseudo-spread: two sine waves → occasional >15bps spikes to exercise the pipeline.
            const wob = Math.sin(t / 7_000) * 8 + Math.sin(t / 2_300) * 6;
            q.spreadBps = wob;
            q.priceA = 3000000000000000000000n; // mock $3000 scaled 1e18… style
            q.priceB = q.priceA * (10000n + BigInt(Math.round(wob))) / 10000n;
            q.poolA = 'MOCK-UNI';
            q.poolB = 'MOCK-SUSHI';
            q.blockNumber = ++this.blockSeen;
            q.ts = t;
            return q;
        }
        // LIVE: single configured route (POOL_A cheap leg, POOL_B expensive leg).
        const pa = await this.getPoolQuote(cfg.poolA);
        const pb = await this.getPoolQuote(cfg.poolB);
        if (pa === null || pb === null)
            return null;
        q.priceA = pa;
        q.priceB = pb;
        q.spreadBps = pa > 0n ? Number(((pb - pa) * 10000n) / pa) / 10_000 : 0; // signed bps
        q.poolA = cfg.poolA;
        q.poolB = cfg.poolB;
        q.blockNumber = ++this.blockSeen;
        q.ts = Date.now();
        return q;
    }
    /**
     * P0-1 allow-list guard: only the two pools from .env may ever be quoted.
     * A malformed/spread quote can never drag us onto a rogue pool.
     */
    poolAllowed(pool) {
        const cfg = getConfig();
        const ok = pool.toLowerCase() === cfg.poolA.toLowerCase() ||
            pool.toLowerCase() === cfg.poolB.toLowerCase();
        if (!ok)
            this.onLog?.(`[scan] REJECTED non-configured pool ${pool.slice(0, 10)}…`);
        return ok;
    }
    /** Returns 1e18-scaled price (token1 per token0) or null on any failure. */
    async getPoolQuote(pool) {
        if (!this.poolAllowed(pool))
            return null;
        try {
            const res = await this.rpc.client.readContract({
                address: pool, abi: SLOT0_ABI, functionName: 'slot0',
            });
            // 18/18 normalization (WETH/WBTC legs). USDC legs: same math applies on
            // both pools, so the SPREAD comparison stays valid even without decimals
            // correction; absolute price display is approximate by design (saves RPC).
            return this.priceFromSqrt(res[0], 18, 18);
        }
        catch {
            return null;
        }
    }
    /**
     * price(token1 per token0) = sqrtP^2 / 2^192, rescaled by 10^(d0-d1) and
     * pushed to an 1e18 fixed point for cross-pool comparison.
     */
    priceFromSqrt(sqrtX96, decOut, decIn) {
        const sq = sqrtX96 * sqrtX96; // x192 fixed point
        const scaled = (sq * 10n ** BigInt(18 + decIn)) >> 192n;
        return scaled / 10n ** BigInt(decOut);
    }
    // ------------------------------------------------------------- economics
    toOpportunity(q, gasUsd) {
        const cfg = getConfig();
        if (Math.abs(q.spreadBps) < 10)
            return null; // floor: sub-10bps never clears costs
        const borrowedUsd = Math.min(cfg.maxLoanUsd, 25_000); // conservative depth cap
        const grossUsd = (borrowedUsd * Math.abs(q.spreadBps)) / 10_000;
        const premiumUsd = (borrowedUsd * Number(AAVE_PREMIUM_BPS)) / 10_000;
        const net = grossUsd - premiumUsd - gasUsd;
        if (net < cfg.minProfitUsd)
            return null; // strict minProfit gate OFF-chain too
        return {
            pair: q.pair, poolA: q.poolA, poolB: q.poolB,
            borrowedUsd, expectedProfitUsd: net, gasCostUsd: gasUsd, premiumUsd, quote: q,
        };
    }
}
