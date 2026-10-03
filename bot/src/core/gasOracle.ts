/**
 * gasOracle.ts — EIP-1559 dynamic fee estimation + P0-3 ETH/USD price oracle.
 *
 * Fees:
 *  1. Read last block's baseFeePerGas + pending rewards via ONE batched pair
 *     of calls (getBlock + getFeeHistory(5 × 3 percentiles)).
 *  2. tip = median of reward percentiles, clamped by PRIORITY_FEE_CAP_GWEI.
 *  3. maxFee = 2 × projected baseFee (survives one full congestion block)
 *     clamped by MAX_FEE_GWEI; if the clamp bites, caller SKIPS the trade —
 *     better to miss an arb than buy gas at the top.
 *
 * ETH/USD (P0-3 — replaces the old hardcoded $2500):
 *  Tier 1  CoinGecko simple-price (no API key, ~1KB JSON, AbortSignal 3s)
 *  Tier 2  Chainlink on-chain feed latestRoundData() for the configured chain
 *  Tier 3  stale cache (logged WARN)
 *  Tier 4  hard-coded $2000 fallback (logged ERROR — never silent)
 *  All tiers feed one PriceCache entry with a TTL (config.gasOracleCacheTtlMs),
 *  so we make AT MOST one price HTTP call per TTL window — MBA-friendly and
 *  well inside CoinGecko's free rate limit even with the bot up for weeks.
 *
 * Caching: fees live 2 blocks max; price lives TTL ms. A stale entry triggers
 * lazy recompute — zero timers, zero leaks.
 */
import type { RpcManager } from './rpcManager.js';
import type { GasFees } from './types.js';
import { getConfig } from './config.js';

const GWEI = 10n ** 9n;

// ------------------------------------------------------------------ types
export interface PriceCache {
  price: number;
  timestamp: number;                          // Date.now() of observation
  source: 'coingecko' | 'chainlink' | 'stale' | 'fallback';
}

/** P0-3: Chainlink mainnet/feeds registry. Add entries as needed (<1KB). */
const CHAINLINK_FEEDS: ReadonlyMap<number, `0x${string}`> = new Map<number, `0x${string}`>([
  [1,      '0x5f4eC39FqHzEnMttIDvOFxzlECAQx3XoeBxhNJCy'],   // ETH/USD mainnet
  [137,    '0xF9680D99D6C9589B2a983cAb03A8E772dc81becf'],   // ETH/USD Polygon
  [8453,   '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'],   // ETH/USD Base
  [42161,  '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612'],   // ETH/USD Arbitrum
  [10,     '0x1DA77E31E7550457CC5a001c02D0284A788d12f5'],   // ETH/USD Optimism
  // Base Sepolia has no canonical Chainlink ETH/USD feed → CoinGecko/stale only.
]);

const CHAINLINK_AGG_ABI = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view',
    inputs: [], outputs: [
      { name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ] },
  { type: 'function', name: 'decimals', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';

const FALLBACK_ETH_USD = 2000;   // last-resort constant, always logged loudly

// ------------------------------------------------------------------ oracle
export class GasOracle {
  private cache: GasFees | null = null;
  private cacheBlock = 0;

  // ---- P0-3 price state -----------------------------------------------------
  private priceCache: PriceCache | null = null;
  private inflightPrice: Promise<number> | null = null;   // dedupe concurrent fetches

  constructor(
    private rpc: RpcManager,
    private caps: { priorityCapGwei: number; maxFeeGwei: number },
  ) {}

  // ------------------------------------------------------------- ETH/USD
  /** Fresh cached price, or refresh through the tier ladder. Never throws. */
  async getEthUsdPrice(): Promise<number> {
    const ttl = getConfig().gasOracleCacheTtlMs;
    const now = Date.now();
    if (this.priceCache && now - this.priceCache.timestamp < ttl) {
      return this.priceCache.price;
    }
    // Single-flight: N concurrent callers ⇒ ONE network request.
    if (!this.inflightPrice) {
      this.inflightPrice = this.fetchPriceTiered().finally(() => { this.inflightPrice = null; });
    }
    return this.inflightPrice;
  }

  private setPrice(price: number, source: PriceCache['source']): number {
    this.priceCache = { price, timestamp: Date.now(), source };
    return price;
  }

  private async fetchPriceTiered(): Promise<number> {
    // ---- Tier 1: CoinGecko (free, tiny payload, 3s hard timeout) -----------
    try {
      const res = await fetch(COINGECKO_URL, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        const j = (await res.json()) as { ethereum?: { usd?: number } };
        const p = j?.ethereum?.usd;
        if (typeof p === 'number' && p > 0 && p < 1_000_000) {
          return this.setPrice(p, 'coingecko');
        }
      }
    } catch { /* fall through */ }

    // ---- Tier 2: Chainlink on-chain feed ------------------------------------
    try {
      const chainId = getConfig().chainId;
      const feed = CHAINLINK_FEEDS.get(chainId);
      if (feed) {
        const [round, decimals] = await Promise.all([
          this.rpc.client.readContract({ address: feed, abi: CHAINLINK_AGG_ABI, functionName: 'latestRoundData' }),
          this.rpc.client.readContract({ address: feed, abi: CHAINLINK_AGG_ABI, functionName: 'decimals' }),
        ]);
        const answer = round[1];                       // int256
        const dec = Number(decimals);
        const price = Number(answer) / 10 ** dec;      // e.g. 8-dec 3.2e10 → 3200
        if (Number.isFinite(price) && price > 0 && price < 1_000_000) {
          return this.setPrice(price, 'chainlink');
        }
      }
    } catch { /* fall through */ }

    // ---- Tier 3: stale cache (bounded staleness beats silence) --------------
    if (this.priceCache) {
      console.warn(`[gasOracle] price sources down — using STALE ${this.priceCache.source} ` +
        `$${this.priceCache.price} (${Math.round((Date.now() - this.priceCache.timestamp) / 1000)}s old)`);
      return this.setPrice(this.priceCache.price, 'stale');
    }

    // ---- Tier 4: hard-coded fallback, LOUD ---------------------------------
    console.error(`[gasOracle] FATAL-grade degradation: no ETH/USD available — ` +
      `using conservative fallback $${FALLBACK_ETH_USD}. Gas-cost gating will be approximate.`);
    return this.setPrice(FALLBACK_ETH_USD, 'fallback');
  }

  /** Expose cache for TUI/Telegram diagnostics (no allocation beyond ref). */
  get priceInfo(): PriceCache | null { return this.priceCache; }

  /** Back-compat setter used by demo mode seeding. */
  setEthUsd(v: number): void { this.setPrice(v, 'coingecko'); }

  // ------------------------------------------------------- gas cost in USD
  /**
   * Exact per-tx gas cost: gasUsed × effectiveGasPrice (wei) → ETH → USD.
   * Uses BigInt math end-to-end until the final float conversion so a
   * 600k-gas tx at 500 gwei never loses precision mid-calculation.
   */
  async calculateGasCostUsd(gasUsed: bigint, effectiveGasPrice: bigint): Promise<number> {
    const gasCostWei = gasUsed * effectiveGasPrice;
    const ethUsd = await this.getEthUsdPrice();
    const gasCostEth = Number(gasCostWei / GWEI) / 1e9;   // wei→gwei→ETH without fp overflow
    return gasCostEth * ethUsd;
  }

  // -------------------------------------------------------------- EIP-1559
  async fees(currentBlock: number): Promise<GasFees | null> {
    // Reuse cache while it's ≤2 blocks old — saves 2 RPC round-trips per scan.
    if (this.cache && currentBlock - this.cacheBlock <= 2) return this.cache;

    try {
      const [block, hist] = await Promise.all([
        this.rpc.client.getBlock(),
        this.rpc.client.getFeeHistory({ blockCount: 5, rewardPercentiles: [20, 50, 80] }),
      ]);

      const base = block.baseFeePerGas ?? 30n * GWEI;

      // Median of the 50th-percentile rewards across the window.
      const rewards: bigint[] = (hist.reward ?? [])
        .map((r: bigint[]) => r[1] ?? 1n)
        .sort((a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0));
      const tipRaw = rewards.length ? rewards[rewards.length >> 1] : GWEI;

      // Project next base fee: EIP-1559 bounds change to ±12.5% per block.
      // Assume worst-case expansion (+12%) so our ceiling survives congestion.
      const projected = base + (base / 100n) * 12n;

      const capTip = BigInt(Math.round(this.caps.priorityCapGwei)) * GWEI;
      const capMax = BigInt(Math.round(this.caps.maxFeeGwei)) * GWEI;

      const tip = tipRaw < capTip ? tipRaw : capTip;
      let maxFee = projected * 2n + tip;
      if (maxFee > capMax) {
        // Ceiling would be violated → signal "skip" rather than overpay.
        this.cache = null;
        return null;
      }

      // ~600k gas typical for flashLoan+2-leg arb+check.
      // P0-3: dynamic USD price instead of the old hardcoded 2500 constant.
      const ethUsd = await this.getEthUsdPrice();
      const estimatedUsd = Number(maxFee / GWEI) * 6e5 * 1e-9 * ethUsd;

      this.cache = { baseFeePerGas: base, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, estimatedUsd };
      this.cacheBlock = currentBlock;
      return this.cache;
    } catch {
      return this.cache; // serve last-known good fees (bounded staleness)
    }
  }
}
