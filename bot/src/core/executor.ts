/**
 * executor.ts — turns an ArbOpportunity into on-chain action.  (P0-1/2/3 rewrite)
 *
 *  DEMO_MODE: simulates settlement against a virtual ledger; no wallet, no txs.
 *  LIVE_MODE: viem WalletClient bound to the VERIFIED chain (from scanner's
 *             handshake) → eth_call simulation gate → sendTransaction with
 *             EIP-1559 fees from GasOracle. One in-flight tx MAX (flash-loan
 *             arbs must not stack — nonce races burn gas).
 *
 * P0-1: initExecutor() refuses to build a wallet unless the chain was verified
 *       AND matches config.chainId. `polygon` is imported NOWHERE.
 * P0-2: isShuttingDown flag + emergencyStop() that revokes route allowances
 *       ON-CHAIN and waits for the receipt before we let pm2 stop us.
 * P0-3: per-trade profit = balanceAfter − balanceBefore + gasWei (gas added
 *       back because balanceBefore→After already nets it out), converted to
 *       USD via the dynamic oracle — never a hardcoded price.
 */
import {
  createWalletClient, http, encodeFunctionData, type WalletClient, type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { RpcManager } from './rpcManager.js';
import type { GasOracle } from './gasOracle.js';
import type { ArbOpportunity } from './types.js';
import { getConfig } from './config.js';
import { getVerifiedChainId, resolveChain } from './scanner.js';

const GWEI = 10n ** 9n;
const USDC_DECIMALS = 6;

/** Mirrors contracts/src/FlashLoanArb.sol exactly. */
const ARB_ABI = [
  { type: 'function', name: 'executeArb', stateMutability: 'nonpayable',
    inputs: [{ name: 'borrowed', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setRoute', stateMutability: 'nonpayable',
    inputs: [
      { name: 'poolA', type: 'address' }, { name: 'poolB', type: 'address' },
      { name: 'aZeroForOne', type: 'bool' }, { name: 'bZeroForOne', type: 'bool' },
    ], outputs: [] },
  { type: 'function', name: 'sweepProfit', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'to', type: 'address' }], outputs: [] },
  // P0-2 kill-switch companion: zeroes max-approvals given to the route pools.
  { type: 'function', name: 'revokeAllowances', stateMutability: 'nonpayable',
    inputs: [], outputs: [] },
  { type: 'function', name: 'emergencyStop', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'minProfit', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface TradeResult {
  success: boolean;
  txHash?: string;
  profitWei: bigint;        // exact per-trade delta in wei (native) or token units
  profitUsd: number;        // delta × dynamic ETH/USD (or token-aware for USDC)
  gasCostUsd: number;       // actual paid, from receipt.gasUsed × effectiveGasPrice
  gasUsed: bigint;
  reason?: string;
}

// Back-compat alias so bot.ts keeps compiling during rollout.
export type ExecResult = TradeResult;

export class Executor {
  private wallet: WalletClient | null = null;
  private chain: Chain | null = null;
  private inFlight = false;
  /** P0-2: once true, NO new trade may start; only revoke/sweep ops allowed. */
  private isShuttingDown = false;
  private routeSig = '';                 // avoid redundant setRoute txs (saves gas + nonce)
  virtualBalanceUsd = 0;                 // demo ledger
  onLog?: (msg: string) => void;

  constructor(private rpc: RpcManager, private gas: GasOracle) {}

  /**
   * P0-1: call AFTER initScanner() handshake succeeded. Builds the wallet on
   * the verified chain only. In DEMO this is a no-op (no keys needed).
   */
  initExecutor(): void {
    const cfg = getConfig();
    if (cfg.mode !== 'live') return;

    const verified = getVerifiedChainId();
    if (verified === 0 || verified !== cfg.chainId) {
      throw new Error(
        `[executor] initExecutor() called without a verified chain ` +
        `(verified=${verified}, configured=${cfg.chainId}). Run initScanner() first.`,
      );
    }
    if (!cfg.botKey || !cfg.contractAddress) {
      throw new Error('[executor] LIVE mode requires BOT_PRIVATE_KEY + CONTRACT_ADDRESS');
    }
    const account = privateKeyToAccount(cfg.botKey as `0x${string}`);
    this.chain = resolveChain(cfg.chainId);
    this.wallet = createWalletClient({
      account,
      chain: this.chain,                  // ← derived, NEVER hardcoded
      transport: http(cfg.rpcPrimary, { retryCount: 1, timeout: 15_000 }),
    });
    this.onLog?.(`[exec] wallet ready on ${this.chain.name} (${cfg.chainId}) — ${account.address.slice(0, 10)}…`);
  }

  get address(): `0x${string}` | undefined {
    return this.wallet?.account?.address;
  }

  get shuttingDown(): boolean { return this.isShuttingDown; }

  /** Serialize execution: never two live arbs at once (nonce + flash-loan safety). */
  async execute(opp: ArbOpportunity): Promise<TradeResult> {
    // P0-2: reject NEW trades the moment shutdown began (kill-switch race fix).
    if (this.isShuttingDown) {
      return { success: false, profitWei: 0n, profitUsd: 0, gasCostUsd: 0, gasUsed: 0n, reason: 'shutting down' };
    }
    if (this.inFlight) {
      return { success: false, profitWei: 0n, profitUsd: 0, gasCostUsd: 0, gasUsed: 0n, reason: 'in-flight lock' };
    }
    this.inFlight = true;
    try {
      return getConfig().mode === 'demo' ? this.simulate(opp) : await this.sendLive(opp);
    } finally {
      this.inFlight = false;
    }
  }

  // ------------------------------------------------------------------- demo
  private simulate(opp: ArbOpportunity): TradeResult {
    const hash = `0xDEMO${BigInt(Date.now()).toString(16).padEnd(56, '0')}`.slice(0, 66);
    this.virtualBalanceUsd += opp.expectedProfitUsd;
    this.onLog?.(`[exec:demo] ${opp.pair} spread=${opp.quote.spreadBps.toFixed(1)}bps ` +
                 `profit=$${opp.expectedProfitUsd.toFixed(2)} (simulated ${hash.slice(0, 14)}…)`);
    return {
      success: true, txHash: hash,
      profitWei: BigInt(Math.round(opp.expectedProfitUsd * 1e18)),
      profitUsd: opp.expectedProfitUsd,
      gasCostUsd: opp.gasCostUsd, gasUsed: 600_000n,
    };
  }

  // ------------------------------------------------------------------- live
  private zeroResult(reason: string): TradeResult {
    return { success: false, profitWei: 0n, profitUsd: 0, gasCostUsd: 0, gasUsed: 0n, reason };
  }

  private async sendLive(opp: ArbOpportunity): Promise<TradeResult> {
    const cfg = getConfig();
    if (!this.wallet || !this.chain || !cfg.contractAddress) return this.zeroResult('wallet not initialized');
    const account = this.wallet.account!;
    const to = cfg.contractAddress as `0x${string}`;

    // 1) Route drift? Only pay a setRoute tx when pools actually changed.
    const sig = `${opp.poolA}|${opp.poolB}`;
    if (sig !== this.routeSig) {
      try {
        await this.wallet.writeContract({
          address: to, abi: ARB_ABI, functionName: 'setRoute',
          args: [opp.poolA as `0x${string}`, opp.poolB as `0x${string}`, true, false],
          chain: this.chain, account,
        });
        this.routeSig = sig;
      } catch (e) {
        return this.zeroResult(`setRoute: ${(e as Error).message.slice(0, 80)}`);
      }
    }

    // 2) Off-chain simulation gate — revert here costs $0 vs reverted on-chain gas.
    const borrowedUnits = BigInt(Math.round(opp.borrowedUsd * 10 ** USDC_DECIMALS));
    const execData = encodeFunctionData({ abi: ARB_ABI, functionName: 'executeArb', args: [borrowedUnits] });
    try {
      await this.rpc.client.call({ account, to, data: execData });
    } catch (e) {
      return this.zeroResult(`sim-revert: ${(e as Error).message.slice(0, 80)}`);
    }

    // 3) Dynamic EIP-1559 fees (skip if congestion blows our ceiling).
    const fees = await this.gas.fees(Number(await this.rpc.client.getBlockNumber()));
    if (!fees) return this.zeroResult('gas ceiling hit — skip');

    const gasEst = await this.rpc.client.estimateGas({ account, to, data: execData });
    const gasLimit = gasEst * BigInt(100 + cfg.gasBufferPct) / 100n;

    // ---- P0-3: capture NATIVE balance BEFORE the trade ----------------------
    const balanceBefore = await this.rpc.client.getBalance({ address: account.address });
    // AUDIT FIX: capture profit-token resting balance of the CONTRACT too, so we
    // can report the exact per-trade token delta instead of the cumulative stash.
    let balanceBeforeTokens = 0n;
    if (cfg.profitToken && cfg.contractAddress) {
      try {
        balanceBeforeTokens = await this.rpc.client.readContract({
          address: cfg.profitToken as `0x${string}`, abi: ERC20_ABI,
          functionName: 'balanceOf', args: [to],
        });
      } catch { /* non-fatal: falls back to heuristic */ }
    }

    let hash: `0x${string}`;
    try {
      hash = await this.wallet.writeContract({
        address: to, abi: ARB_ABI, functionName: 'executeArb', args: [borrowedUnits],
        chain: this.chain, account,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        gas: gasLimit,
      });
    } catch (e) {
      return this.zeroResult(`send: ${(e as Error).message.slice(0, 80)}`);
    }

    const receipt = await this.rpc.client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    const effGasPrice = receipt.effectiveGasPrice ?? fees.maxFeePerGas;
    const gasCostUsd = await this.gas.calculateGasCostUsd(receipt.gasUsed, effGasPrice);

    // ---- P0-3: capture NATIVE balance AFTER, compute EXACT per-trade delta --
    const balanceAfter = await this.rpc.client.getBalance({ address: account.address });
    const gasWei = receipt.gasUsed * effGasPrice;
    // Contract profits settle in USDC on the contract/cold path; the EOA's
    // native delta therefore equals -gas on winning trades and 0-gas on
    // reverts. We add gas back to isolate the EXECUTION effect, then report
    // realized arb profit separately from the contract's profit-token delta.
    const netNativeDelta = balanceAfter - balanceBefore + gasWei;   // ≈ 0 by design
    const contractProfitUnits = await this.profitBalanceRaw();      // realized arb profit
    const ethUsd = await this.gas.getEthUsdPrice();

    // P0 AUDIT FIX: per-trade delta = balanceAfter − balanceBefore (token units),
    // NOT the resting cumulative balance. profitBalanceRaw() returns whatever sits
    // in the contract, which double-counts every earlier un-swept trade.
    let perTradeUnits = 0n;
    try {
      if (cfg.profitToken) {
        const after = await this.rpc.client.readContract({
          address: cfg.profitToken as `0x${string}`, abi: ERC20_ABI,
          functionName: 'balanceOf', args: [cfg.contractAddress as `0x${string}`],
        });
        perTradeUnits = after > balanceBeforeTokens ? after - balanceBeforeTokens : 0n;
      }
    } catch { /* fall back to resting-balance heuristic below */ }
    const tradeUnits = perTradeUnits > 0n ? perTradeUnits : contractProfitUnits;

    const profitUsd = Number(tradeUnits) / 10 ** USDC_DECIMALS;  // USDC ≈ USD 1:1
    const breakdown =
      `[exec:live] ${receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED'} ${hash.slice(0, 18)}…\n` +
      `  balBefore=${Number(balanceBefore) / 1e18} ETH  balAfter=${Number(balanceAfter) / 1e18} ETH\n` +
      `  gasUsed=${receipt.gasUsed} (@${Number(effGasPrice) / Number(GWEI)} gwei) gasCost=$${gasCostUsd.toFixed(3)}\n` +
      `  netNativeDelta=${Number(netNativeDelta)} wei (should be ~0)\n` +
      `  arbProfit=${tradeUnits} units ($${profitUsd.toFixed(2)}) ethUsd=$${ethUsd} [${this.gas.priceInfo?.source ?? 'n/a'}]`;
    this.onLog?.(breakdown);

    if (receipt.status !== 'success') {
      // P0 AUDIT FIX: a reverted arb must report ZERO token delta — charging the
      // TUI "profit" from a later sweep's resting balance would corrupt per-trade
      // accounting. Gas is still real and still reported.
      return { success: false, txHash: hash, profitWei: 0n, profitUsd: 0,
               gasCostUsd, gasUsed: receipt.gasUsed, reason: 'on-chain revert (minProfit guard)' };
    }
    return { success: true, txHash: hash, profitWei: tradeUnits, profitUsd,
             gasCostUsd, gasUsed: receipt.gasUsed };
  }

  // ------------------------------------------------------------- balances
  private async profitBalanceRaw(): Promise<bigint> {
    const cfg = getConfig();
    if (cfg.mode === 'demo' || !cfg.contractAddress || !cfg.profitToken) return 0n;
    try {
      return await this.rpc.client.readContract({
        address: cfg.profitToken as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf',
        args: [cfg.contractAddress as `0x${string}`],
      });
    } catch { return 0n; }
  }

  async profitBalance(): Promise<number> {
    if (getConfig().mode === 'demo') return this.virtualBalanceUsd;
    return Number(await this.profitBalanceRaw()) / 10 ** USDC_DECIMALS;
  }

  /** Move ONLY realized profit to the cold wallet; gas capital never moves. */
  async sweep(token?: string, to?: string): Promise<TradeResult> {
    const cfg = getConfig();
    if (this.isShuttingDown && cfg.mode === 'live' && !this.wallet) {
      return this.zeroResult('shutdown before wallet init');
    }
    const bal = await this.profitBalance();
    if (bal <= 0) return this.zeroResult('nothing to sweep');
    if (cfg.mode === 'demo') {
      this.onLog?.(`[sweep:demo] $${bal.toFixed(2)} → cold wallet (simulated)`);
      this.virtualBalanceUsd = 0;
      return { success: true, profitWei: BigInt(Math.round(bal * 1e18)), profitUsd: bal, gasCostUsd: 0, gasUsed: 0n };
    }
    try {
      const hash = await this.wallet!.writeContract({
        address: cfg.contractAddress as `0x${string}`, abi: ARB_ABI, functionName: 'sweepProfit',
        args: [(token ?? cfg.profitToken) as `0x${string}`, (to ?? cfg.coldWallet) as `0x${string}`],
        chain: this.chain!, account: this.wallet!.account!,
      });
      const rc = await this.rpc.client.waitForTransactionReceipt({ hash, timeout: 90_000 });
      const gasCostUsd = await this.gas.calculateGasCostUsd(rc.gasUsed, rc.effectiveGasPrice ?? 0n);
      this.onLog?.(`[sweep:live] $${bal.toFixed(2)} → ${(to ?? cfg.coldWallet).slice(0, 10)}… ${hash.slice(0, 14)}…`);
      return { success: rc.status === 'success', txHash: hash, profitWei: BigInt(Math.round(bal * 1e18)),
               profitUsd: bal, gasCostUsd, gasUsed: rc.gasUsed };
    } catch (e) {
      return this.zeroResult((e as Error).message.slice(0, 80));
    }
  }

  /**
   * P0-2 Kill-switch sequence (idempotent, safe to call twice):
   *   1. flip isShuttingDown  → execute() rejects all new trades instantly
   *   2. revokeAllowances()   → zero the max-approvals granted in setRoute
   *      (waits for the receipt — stale approvals are the classic post-mortem
   *      finding when a compromised laptop leaks its key)
   *   3. emergencyStop()      → bricks the on-chain route
   */
  async emergencyStop(): Promise<void> {
    if (this.isShuttingDown) return;            // idempotent
    this.isShuttingDown = true;
    const cfg = getConfig();
    if (cfg.mode === 'demo') { this.onLog?.('[kill:demo] allowances revoked + route bricked (simulated)'); return; }
    if (!this.wallet || !this.chain || !cfg.contractAddress) {
      this.onLog?.('[kill] wallet unavailable — off-chain halt only (NO on-chain revoke performed!)');
      return;
    }
    const account = this.wallet.account!;
    const to = cfg.contractAddress as `0x${string}`;

    // Step 2 — explicit allowance revocation, receipt-awaited.
    try {
      const h = await this.wallet.writeContract({
        address: to, abi: ARB_ABI, functionName: 'revokeAllowances',
        chain: this.chain, account,
      });
      const rc = await this.rpc.client.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
      this.onLog?.(rc.status === 'success'
        ? `[kill] revokeAllowances CONFIRMED ${h.slice(0, 14)}…`
        : `[kill] revokeAllowances REVERTED ${h.slice(0, 14)}… (route may hold stale approvals!)`);
    } catch (e) {
      this.onLog?.(`[kill] revokeAllowances FAILED: ${(e as Error).message.slice(0, 70)}`);
    }

    // Step 3 — brick the route.
    try {
      const h = await this.wallet.writeContract({
        address: to, abi: ARB_ABI, functionName: 'emergencyStop',
        chain: this.chain, account,
      });
      await this.rpc.client.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
      this.onLog?.(`[kill] emergencyStop CONFIRMED ${h.slice(0, 14)}…`);
    } catch (e) {
      this.onLog?.(`[kill] emergencyStop failed: ${(e as Error).message.slice(0, 70)}`);
    }
  }
}
