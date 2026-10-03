/**
 * config.ts — single source of truth for env-derived configuration.
 *
 * P0-1 FIX: nothing in the bot may hardcode a chainId or an address again.
 * Every address + the chain come from .env, are validated at boot, and any
 * module that needs them reads them through getConfig().
 *
 * Memory strategy (2017 MBA / 8GB):
 *  - Parsed ONCE at boot into a frozen object; no per-tick env lookups.
 *  - No JSON blobs kept in memory beyond the pair registry (<2KB).
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
// ------------------------------------------------------------------ helpers
function fail(key, why) {
    console.error(`[config] FATAL — ${key}: ${why}`);
    process.exit(1); // fail fast BEFORE TUI/Telegram init
}
const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};
/** Required positive integer (chainId, caps…). */
function reqPositiveInt(key) {
    const raw = process.env[key];
    if (!raw)
        fail(key, 'missing — set it in .env');
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0)
        fail(key, `expected positive integer, got "${raw}"`);
    return n;
}
/** Optional address: must match ^0x[0-9a-fA-F]{40}$ when present. */
function optAddress(key, fallback = '') {
    const v = (process.env[key] ?? '').trim();
    if (!v)
        return fallback;
    if (!ADDR_RE.test(v))
        fail(key, `invalid address format: "${v.slice(0, 10)}…"`);
    return v;
}
/** Address that MUST be present and non-zero (LIVE-critical ones). */
function reqAddress(key) {
    const v = optAddress(key);
    if (!v)
        fail(key, 'required but empty in .env');
    if (v.toLowerCase() === ZERO_ADDR)
        fail(key, 'refusing zero address');
    return v;
}
function parsePairs(raw) {
    return (raw ?? 'WETH/USDC')
        .split(',')
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 16) // hard cap: never let a fat env var balloon the scanner
        .map((p) => {
        const [tokenA, tokenB] = p.split('/');
        return { tokenA: tokenA ?? '', tokenB: tokenB ?? '' };
    })
        .filter((p) => p.tokenA && p.tokenB);
}
// ------------------------------------------------------------------ build
function buildConfig() {
    const mode = process.argv.includes('--mode')
        ? process.argv[process.argv.indexOf('--mode') + 1]
        : (process.env.DEMO_MODE === 'false' ? 'live' : 'demo');
    if (mode !== 'demo' && mode !== 'live')
        fail('MODE', `"${mode}" is not demo|live`);
    const cfg = Object.freeze({
        mode,
        logLevel: process.env.LOG_LEVEL ?? 'info',
        // ---- P0-1: chain + addresses strictly from .env ----------------------
        chainId: reqPositiveInt('CHAIN_ID'),
        rpcPrimary: (() => {
            const v = (process.env.RPC_PRIMARY ?? '').trim();
            if (!v)
                fail('RPC_PRIMARY', 'missing — set it in .env');
            if (!/^https?:\/\//.test(v))
                fail('RPC_PRIMARY', `must be http(s) URL, got "${v.slice(0, 20)}"`);
            return v;
        })(),
        rpcBackups: Object.freeze([process.env.RPC_BACKUP_1, process.env.RPC_BACKUP_2].filter(Boolean)),
        rpcMaxLatencyMs: num(process.env.RPC_MAX_LATENCY_MS, 200),
        botKey: process.env.BOT_PRIVATE_KEY ?? '',
        coldWallet: optAddress('COLD_WALLET', ZERO_ADDR),
        contractAddress: optAddress('CONTRACT_ADDRESS'), // deploy.sh writes this back
        aavePool: optAddress('AAVE_V3_POOL', ZERO_ADDR),
        profitToken: optAddress('PROFIT_TOKEN'),
        borrowToken: optAddress('BORROW_TOKEN'),
        poolA: optAddress('POOL_A'),
        poolB: optAddress('POOL_B'),
        minProfitUsd: num(process.env.MIN_PROFIT_USD, 5),
        maxLoanUsd: num(process.env.MAX_LOAN_USD, 50_000),
        sweepThresholdUsd: num(process.env.SWEEP_THRESHOLD_USD, 50),
        pairs: Object.freeze(parsePairs(process.env.PAIRS)),
        priorityFeeCapGwei: num(process.env.PRIORITY_FEE_CAP_GWEI, 50),
        maxFeeGwei: num(process.env.MAX_FEE_GWEI, 500),
        gasBufferPct: num(process.env.GAS_BUFFER_PCT, 15),
        gasOracleCacheTtlMs: num(process.env.GAS_ORACLE_CACHE_TTL_MS, 600_000),
        telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
        telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
        maxConcurrentScans: num(process.env.MAX_CONCURRENT_SCANS, 4),
        wsMaxSubscriptions: num(process.env.WS_MAX_SUBSCRIPTIONS, 2),
        heapSoftLimitMb: num(process.env.HEAP_SOFT_LIMIT_MB, 384),
        pm2AppName: (process.env.PM2_APP_NAME ?? 'flash-loan-arb').trim(),
    });
    // Cross-field validation — only enforced hard in LIVE mode so DEMO can run
    // on a fresh clone with a skeleton .env.
    if (cfg.mode === 'live') {
        if (!cfg.botKey)
            fail('BOT_PRIVATE_KEY', 'required in LIVE mode');
        if (!ADDR_RE.test(cfg.botKey.replace(/^(0x)?/, '0x')) || cfg.botKey.length !== 66) {
            fail('BOT_PRIVATE_KEY', 'must be 0x + 64 hex chars');
        }
        if (!cfg.contractAddress)
            fail('CONTRACT_ADDRESS', 'run scripts/deploy.sh first');
        if (cfg.coldWallet.toLowerCase() === ZERO_ADDR)
            fail('COLD_WALLET', 'unset — profits would be burned');
        if (cfg.aavePool.toLowerCase() === ZERO_ADDR)
            fail('AAVE_V3_POOL', 'unset — flash loans impossible');
        if (!cfg.profitToken)
            fail('PROFIT_TOKEN', 'required');
        if (!cfg.borrowToken)
            fail('BORROW_TOKEN', 'required');
        if (cfg.poolA && cfg.poolB && cfg.poolA.toLowerCase() === cfg.poolB.toLowerCase()) {
            fail('POOL_B', 'must differ from POOL_A (same-pool arb is always unprofitable)');
        }
    }
    return cfg;
}
// --------------------------------------------------------------- singleton
let current = null;
/** Boot-time singleton. First call parses+validates; later calls are free. */
export function getConfig() {
    if (!current)
        current = buildConfig();
    return current;
}
/**
 * reloadConfig() — re-reads process.env (e.g. after tests mutate it) and swaps
 * the singleton atomically. NOTE: this does NOT hot-swap trading behaviour;
 * MODE changes go through /set_mode → atomicEnvUpdate → pm2 restart (P0-2).
 */
export function reloadConfig(envPath) {
    if (envPath && existsSync(envPath)) {
        // Re-seed process.env from file without dotenv's full re-init cost.
        for (const line of readFileSync(envPath, 'utf8').split('\n')) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
            if (m)
                process.env[m[1]] = m[2].trim();
        }
    }
    current = buildConfig();
    return current;
}
/** Legacy alias kept so older imports don't break mid-refactor. */
export const CFG = getConfig();
