/**
 * index.ts — process entrypoint.
 *
 * 2017 MBA boot sequence:
 *   node --max-old-space-size=384 dist/index.js [--mode demo|live]
 *
 * We deliberately do NOT import the TUI/Telegram until after core init so a
 * broken .env fails fast without spinning up screen buffers or polling loops.
 */
import { CFG } from './core/config.js';
import { Bot } from './core/bot.js';

async function main(): Promise<void> {
  const bot = new Bot();

  // Mode override from CLI wins over env (pm2 ecosystem passes --mode).
  if (bot.stats.mode !== CFG.mode) bot.stats.mode = CFG.mode;

  // P0-1: chain handshake + wallet binding BEFORE any timers start.
  await bot.init();
  bot.start();

  // UIs are optional & lazy — require() only what we need, when we need it.
  const { startTui } = await import('./ui/tui.js');
  startTui(bot);

  const stopTelegram = (await import('./ui/telegram.js')).startTelegram(bot);

  // Graceful shutdown: pm2 sends SIGINT then SIGKILL after `kill_timeout`.
  // We must clear timers + close grammy polling or macOS leaves zombie FDs.
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    bot.log(`[main] ${sig} received — graceful shutdown`);
    stopTelegram?.();
    bot.stop(sig);
    // Give in-flight RPC calls ≤1s to settle, then hard exit (no dangling sockets).
    setTimeout(() => process.exit(0), 1_000).unref?.();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Last-resort handlers: an unref'd timer that leaked past our budget would
  // keep this process alive forever on a laptop — log and die instead.
  process.on('unhandledRejection', (r) => bot.log(`[main] unhandledRejection: ${String(r).slice(0, 120)}`));
  process.on('uncaughtException', (e) => {
    bot.log(`[main] FATAL uncaughtException: ${e.message.slice(0, 120)}`);
    void shutdown('uncaughtException');
  });
}

main().catch((e) => { console.error('[main] boot failed:', e); process.exit(1); });
