/**
 * types.ts — shared lightweight structs. Plain objects, no classes → less
 * prototype-chain memory per instance (matters when we churn thousands of
 * quote objects per minute on a dual-core i5).
 */
export interface PairQuote {
  pair: string;            // "WETH/USDC"
  poolA: string;           // executor-style address label (mock in demo)
  poolB: string;
  priceA: bigint;          // scaled 1e18 fixed-point
  priceB: bigint;
  spreadBps: number;       // signed: positive => A cheaper (buy A, sell B)
  blockNumber: number;
  ts: number;              // Date.now() of observation
}

export interface ArbOpportunity {
  pair: string;
  poolA: string;
  poolB: string;
  borrowedUsd: number;
  expectedProfitUsd: number;   // NET of gas + Aave premium
  gasCostUsd: number;
  premiumUsd: number;
  quote: PairQuote;
}

export interface GasFees {
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;        // 2*base + tip (EIP-1559 best practice)
  estimatedUsd: number;        // for a ~600k-gas arb tx
}

export type RpcState = 'healthy' | 'degraded' | 'down';

export interface RpcInfo {
  url: string;
  latencyMs: number;           // EWMA-smoothed
  state: RpcState;
  failures: number;
}

export interface BotStats {
  mode: string;
  trading: boolean;
  activePairs: number;
  blocksSeen: number;
  opportunities: number;
  tradesExecuted: number;
  tradesSkipped: number;
  totalProfitUsd: number;
  gasSpentUsd: number;
  ramMb: number;
  rpc: RpcInfo;
  uptimeSec: number;
}
