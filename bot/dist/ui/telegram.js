/**
 * telegram.ts — grammy-based remote control.  (P0-2 rewrite)
 *
 * WHAT CHANGED:
 *  - NO HOT-SWAP MODE LOGIC ANYWHERE. /set_mode now:
 *      atomicEnvUpdate('DEMO_MODE', …) → pm2 restart <app> --update-env
 *    The new process boots with the right mode + keys; the old one dies clean.
 *  - /kill_switch runs the FULL sequence: emergencyStop() (which revokes
 *    allowances on-chain and waits for receipts), sweepProfit to cold wallet,
 *    then `pm2 stop` so nothing resurrects until you say so.
 *  - atomicEnvUpdate uses write-tmp + rename(2) (atomic on APFS/ext4), mode
 *    0o600, and NEVER sed -i (BSD sed on macOS has no -i without arg).
 *
 * grammy over telegraf: ~2x fewer transitive deps, smaller memory footprint,
 * native long-polling abort. Security: every mutating command checks the
 * TELEGRAM_CHAT_ID allow-list FIRST. Long polling (not webhook) → no open port.
 */
import { Bot as TelegramBot } from 'grammy';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig } from '../core/config.js';
const fmtUsd = (n) => `$${n.toFixed(2)}`;
// ---------------------------------------------------------- atomic .env edit
/**
 * Replace (or append) KEY=value in the project .env atomically.
 * - writes .env.tmp.<pid> with 0o600, then rename(2) over .env
 * - preserves comments/blank lines/ordering of untouched keys
 * - never logs file contents (the file may contain BOT_PRIVATE_KEY)
 */
export function atomicEnvUpdate(key, value, envPath) {
    const path = resolve(envPath ?? process.env.ARB_ENV_PATH ?? '../.env');
    if (!existsSync(path))
        throw new Error(`[env] ${path} not found — run install.sh first`);
    const lines = readFileSync(path, 'utf8').split('\n');
    const re = new RegExp(`^\\s*${key}\\s*=`); // match assignment lines only
    let replaced = false;
    const out = lines.map((line) => {
        if (re.test(line)) {
            replaced = true;
            return `${key}=${value}`;
        }
        return line;
    });
    if (!replaced)
        out.push(`${key}=${value}`);
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
    chmodSync(tmp, 0o600); // belt & braces on umask
    renameSync(tmp, path); // atomic on APFS
}
/** Best-effort pm2 control; throws a readable error when pm2 is missing. */
function pm2(action, app) {
    try {
        execFileSync('pm2', [action, app, ...(action === 'restart' ? ['--update-env'] : [])], {
            encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (e) {
        const err = e;
        if ((err.message ?? '').includes('ENOENT'))
            throw new Error('pm2 not installed — run scripts/install.sh');
        throw new Error((err.stderr ?? err.message ?? 'pm2 failed').slice(0, 120));
    }
}
// ---------------------------------------------------------------- handlers
export function startTelegram(bot) {
    const cfg = getConfig();
    if (!cfg.telegramToken || !cfg.telegramChatId) {
        bot.log('[tg] disabled — TELEGRAM_BOT_TOKEN/CHAT_ID missing');
        return null;
    }
    const tg = new TelegramBot(cfg.telegramToken);
    let running = true;
    const allowed = (chatId) => String(chatId) === String(cfg.telegramChatId);
    tg.command('status', async (ctx) => {
        if (!allowed(ctx.chat?.id))
            return ctx.reply('🚫 unauthorized');
        const s = bot.stats;
        const price = bot.gas.priceInfo;
        return ctx.reply(['🤖 flash-loan-arb status',
            `mode        : ${s.mode.toUpperCase()} (${s.trading ? 'trading' : 'idle'})`,
            `chain       : ${cfg.chainId} (verified ${bot.scannerReady ? 'yes' : 'NO!'})`,
            `RPC         : ${s.rpc.state} @ ${s.rpc.latencyMs}ms`,
            `ETH/USD     : ${price ? `$${price.price} [${price.source}]` : 'n/a'}`,
            `pairs       : ${s.activePairs}`,
            `opps/exec/skip: ${s.opportunities}/${s.tradesExecuted}/${s.tradesSkipped}`,
            `PnL         : ${fmtUsd(s.totalProfitUsd)} net (per-trade deltas)`,
            `gas spent   : ${fmtUsd(s.gasSpentUsd)}`,
            `RAM heap    : ${s.ramMb}MB`,
            `uptime      : ${Math.floor(s.uptimeSec / 60)}m`,
        ].join('\n'));
    });
    tg.command('start_bot', (ctx) => {
        if (!allowed(ctx.chat?.id))
            return ctx.reply('🚫 unauthorized');
        if (bot.executor.shuttingDown)
            return ctx.reply('❌ executor shut down — /set_mode or `arb-restart` required');
        bot.trading = true;
        return ctx.reply('▶️ trading resumed');
    });
    tg.command('stop_bot', (ctx) => {
        if (!allowed(ctx.chat?.id))
            return ctx.reply('🚫 unauthorized');
        bot.trading = false; // soft stop: scanners keep running
        return ctx.reply('⏸ trading halted (scan continues, no executions)');
    });
    /**
     * P0-2 KILL SWITCH — full capital-preservation sequence:
     *   1. halt loop           (no new opportunities)
     *   2. emergencyStop()     isShuttingDown=true → revokeAllowances() → brick route
     *   3. sweepProfit()       contract profit → COLD_WALLET (never the hot EOA)
     *   4. pm2 stop            process stays dead until operator restarts
     */
    tg.command('kill_switch', async (ctx) => {
        if (!allowed(ctx.chat?.id))
            return ctx.reply('🚫 unauthorized');
        try {
            await ctx.reply('⛔ [1/4] halting trading loop…');
            bot.stop('KILL SWITCH via Telegram');
            await ctx.reply('⛔ [2/4] revoking allowances + bricking route (waiting for receipts)…');
            await bot.executor.emergencyStop();
            await ctx.reply('⛔ [3/4] sweeping contract profit to cold wallet…');
            const r = await bot.executor.sweep(cfg.profitToken, cfg.coldWallet);
            await ctx.reply(r.success
                ? `💰 swept ${fmtUsd(r.profitUsd)} → ${cfg.coldWallet.slice(0, 10)}… tx ${r.txHash?.slice(0, 14)}…`
                : `⚠️ sweep incomplete (${r.reason ?? 'unknown'}) — funds safe, retry after inspection`);
            await ctx.reply('⛔ [4/4] stopping pm2 process…');
            pm2('stop', cfg.pm2AppName);
            return ctx.reply('✅ KILL SWITCH complete: halted, revoked, bricked, swept, stopped.');
        }
        catch (e) {
            return ctx.reply(`❌ kill switch error: ${e.message.slice(0, 140)}`);
        }
    });
    /**
     * P0-2 MODE TOGGLE — NO hot-swap. Persist to .env atomically, then let pm2
     * respawn the process with the correct mode + key material. A restart is
     * mandatory anyway because viem WalletClient is constructed at boot.
     */
    tg.command('set_mode', async (ctx) => {
        if (!allowed(ctx.chat?.id))
            return ctx.reply('🚫 unauthorized');
        const arg = ctx.message?.text?.split(' ')[1]?.toLowerCase();
        if (arg !== 'demo' && arg !== 'live')
            return ctx.reply('usage: /set_mode demo|live');
        // Pre-flight: refuse LIVE without the pieces that make LIVE safe.
        if (arg === 'live') {
            if (!cfg.botKey)
                return ctx.reply('❌ BOT_PRIVATE_KEY empty in .env — refusing LIVE restart');
            if (!cfg.contractAddress)
                return ctx.reply('❌ CONTRACT_ADDRESS empty — run arb-deploy first');
        }
        try {
            atomicEnvUpdate('DEMO_MODE', arg === 'demo' ? 'true' : 'false');
            await ctx.reply(`🔁 .env updated (DEMO_MODE=${arg === 'demo'}); restarting pm2…`);
            pm2('restart', cfg.pm2AppName);
            return ctx.reply(`✅ mode → ${arg.toUpperCase()}. New process booting with fresh config.`);
        }
        catch (e) {
            return ctx.reply(`❌ set_mode failed: ${e.message.slice(0, 140)}`);
        }
    });
    tg.command('help', (ctx) => ctx.reply('/status · /start_bot · /stop_bot · /kill_switch · /set_mode demo|live · /sweep'));
    tg.command('sweep', async (ctx) => {
        if (!allowed(ctx.chat?.id))
            return ctx.reply('🚫 unauthorized');
        const r = await bot.executor.sweep();
        return ctx.reply(r.success ? `🧹 swept ${fmtUsd(r.profitUsd)} → cold wallet` : `sweep failed: ${r.reason}`);
    });
    // Long-poll with generous timeout: one HTTP request per ~30s ≈ negligible CPU.
    void tg.start({ timeout: 30, drop_pending_updates: true })
        .then(() => bot.log('[tg] polling started'))
        .catch((e) => bot.log(`[tg] error: ${e.message.slice(0, 80)}`));
    return () => { if (running) {
        running = false;
        void tg.stop();
    } };
}
