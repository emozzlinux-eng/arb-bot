let b = null;
export function startTui(bot) {
    // In a non-TTY environment (pm2 logs, CI), skip the TUI entirely — this also
    // prevents blessed from spawning invisible screen buffers that leak FDs.
    if (!process.stdout.isTTY) {
        const t = setInterval(() => {
            for (const line of bot.recentLogs(3))
                console.log(line);
        }, 5_000);
        t.unref?.();
        return;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    b = require('blessed');
    const Blessed = b;
    const screen = Blessed.screen({ smartCSR: true, title: 'flash-loan-arb' });
    const header = Blessed.text({
        parent: screen, top: 0, left: 1, content: '{bold}⚡ FLASH LOAN ARB — Aave V3 × UniV3/Sushi{/bold}',
        tags: true,
    });
    const statsBox = Blessed.box({
        parent: screen, label: ' STATS ', border: 'line',
        top: 1, left: 1, width: '48%', height: 10, style: { border: { fg: 'cyan' } },
    });
    const rpcBox = Blessed.box({
        parent: screen, label: ' RPC HEALTH ', border: 'line',
        top: 1, left: '50%', width: '48%', height: 10, style: { border: { fg: 'yellow' } },
    });
    const pairsBox = Blessed.box({
        parent: screen, label: ' ACTIVE PAIRS ', border: 'line',
        top: 11, left: 1, width: '48%', height: 12, style: { border: { fg: 'magenta' } },
    });
    const logBox = Blessed.box({
        parent: screen, label: ' LIVE LOGS ', border: 'line',
        top: 11, left: '50%', width: '48%', height: '75%',
        scrollable: true, alwaysScroll: true, keys: true, mouse: true,
        style: { border: { fg: 'green' } },
    });
    const statusline = Blessed.text({
        parent: screen, bottom: 0, left: 1, right: 1, height: 1,
        content: ' q: quit | s: stop/start trading | m: toggle mode | r: force sweep',
        style: { fg: 'gray' },
    });
    screen.key(['q', 'C-c'], () => { bot.stop('TUI quit'); screen.destroy(); process.exit(0); });
    screen.key(['s'], () => { bot.trading = !bot.trading; bot.log(`[tui] trading=${bot.trading}`); });
    // P0-2: hot-swap removed. 'm' now only flips the DISPLAY label and reminds
    // the operator to use /set_mode (Telegram) or `arb-live`/`arb-start` (pm2).
    screen.key(['m'], () => bot.setModeLabel(bot.stats.mode === 'demo' ? 'live' : 'demo'));
    screen.key(['r'], () => { void bot.executor.sweep().then((r) => bot.log(`[tui] sweep: ${r.success ? '$' + r.profitUsd.toFixed(2) : r.reason}`)); });
    const paint = () => {
        const st = bot.stats;
        statsBox.setContent([
            `Mode        : {fg-cyan}${st.mode.toUpperCase()}{/fg-cyan}   Trading: ${st.trading ? 'ON' : 'OFF'}`,
            `PnL (net)   : $${st.totalProfitUsd.toFixed(2)}`,
            `Gas spent   : $${st.gasSpentUsd.toFixed(2)}`,
            `Executed    : ${st.tradesExecuted}   skipped: ${st.tradesSkipped}`,
            `RAM heap    : ${st.ramMb} MB`,
            `Uptime      : ${Math.floor(st.uptimeSec / 60)}m ${st.uptimeSec % 60}s`,
        ].join('\n'));
        const rpc = st.rpc;
        const col = rpc.state === 'healthy' ? 'green' : rpc.state === 'degraded' ? 'yellow' : 'red';
        rpcBox.setContent([
            `Endpoint : ${rpc.url.replace(/^https?:\/\//, '').slice(0, 34)}`,
            `Latency  : {fg-${col}}${rpc.latencyMs} ms{/fg-${col}} (EWMA)`,
            `State    : {fg-${col}}${rpc.state.toUpperCase()}{/fg-${col}}`,
            `Failures : ${rpc.failures}`,
            `Blocks   : ${st.blocksSeen}`,
        ].join('\n'));
        const rows = bot.scanner.latestQuotes().map((q) => `${q.pair.padEnd(11)} spread ${q.spreadBps >= 0 ? '+' : ''}${q.spreadBps.toFixed(1).padStart(6)} bps  blk ${q.blockNumber}`);
        pairsBox.setContent(rows.length ? rows.join('\n') : 'waiting for first scan…');
        logBox.setContent(bot.recentLogs(40).reverse().join('\n'));
        screen.render();
    };
    const timer = setInterval(paint, 1_000);
    timer.unref?.();
    paint();
}
