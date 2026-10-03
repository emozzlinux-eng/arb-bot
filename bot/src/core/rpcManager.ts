/**
 * rpcManager.ts — health-monitored, auto-failover RPC layer.
 *
 * Why hand-rolled instead of viem's `withFallback`: we need (a) an EWMA latency
 * score feeding the TUI, (b) a single shared HTTP keep-alive agent to avoid
 * socket churn on the MBA's limited file-descriptor budget, and (c) failover
 * WITHOUT dropping in-flight requests (viem fallback retries whole calls).
 *
 * Memory notes:
 *  - One viem `createClient` per endpoint, built once at boot (3 clients max).
 *  - Latency history is a fixed Float64 ring buffer (64 samples ≈ 512 B/RPC).
 *  - PERF: the ring's p95() sorts IN PLACE inside a scratch Float64Array that
 *    is allocated ONCE per ring — no per-call array + closure allocations.
 *  - PERF: pingAll() is re-entrancy guarded and its interval callback is
 *    error-contained so one rejected health check can never kill monitoring.
 */
import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import type { RpcInfo } from './types.js';

const SAMPLES = 64;

class LatencyRing {
  private buf = new Float64Array(SAMPLES);
  private scratch = new Float64Array(SAMPLES);   // reused sort buffer — zero churn
  private i = 0;
  private n = 0;
  push(ms: number) { this.buf[this.i] = ms; this.i = (this.i + 1) % SAMPLES; if (this.n < SAMPLES) this.n++; }
  p95(): number {
    if (!this.n) return Infinity;
    const s = this.scratch.subarray(0, this.n);
    s.set(this.buf.subarray(0, this.n));         // copy into pre-allocated buffer
    s.sort();                                    // TypedArray sort = numeric by default, no comparator alloc
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }
}

export class RpcManager {
  private endpoints: string[];
  private clients: PublicClient[] = [];
  private rings: LatencyRing[] = [];
  private failures: number[] = [];
  private ewma: number[] = [];
  private active = 0;                       // index into endpoints
  private timer: NodeJS.Timeout | null = null;
  private wsCount = 0;
  private maxWs: number;
  private thresholdMs: number;
  /** Called on every successful ping & failover so TUI/Telegram can react. */
  onEvent?: (msg: string) => void;

  constructor(opts: { primary: string; backups: string[]; thresholdMs: number; maxWs: number }) {
    this.endpoints = [opts.primary, ...opts.backups];
    this.thresholdMs = opts.thresholdMs;
    this.maxWs = opts.maxWs;

    // Connection pooling: viem's http transport rides Node 20's global undici
    // dispatcher, which multiplexes & keep-alives sockets per origin. We cap
    // its concurrency by simply never issuing more than (endpoints × 2) calls
    // concurrently — see Scanner's bounded worker window.

    for (const url of this.endpoints) {
      this.clients.push(
        createPublicClient({
          transport: http(url, {
            batch: false,                 // batching adds latency variance; skip it
            retryCount: 1,                // OUR failover logic decides, not viem's
            timeout: 4_000,
            // Node 20's undici global dispatcher already pools keep-alive
            // sockets per origin — no custom fetch hook needed (and viem's
            // HttpTransportConfig doesn't expose one anyway).
          }),
        }),
      );
      this.rings.push(new LatencyRing());
      this.failures.push(0);
      this.ewma.push(0);
    }
  }

  start(intervalMs = 10_000): void {
    void this.pingAll();                                  // fire immediately…
    // PERF/robustness: skip-if-busy (overlapping pings would skew EWMA) and
    // swallow sync throws so a transient failure never kills the interval.
    this.timer = setInterval(() => { void this.pingAll().catch(() => {}); }, intervalMs);
    this.timer.unref?.();                             // never block process exit
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current best client after any failover. Cheap property access, no alloc. */
  get client(): PublicClient { return this.clients[this.active]; }
  get activeUrl(): string { return this.endpoints[this.active]; }

  info(): RpcInfo {
    return {
      url: this.activeUrl,
      latencyMs: Math.round(this.ewma[this.active]),
      state: this.failures[this.active] >= 3 ? 'down' : this.ewma[this.active] > this.thresholdMs ? 'degraded' : 'healthy',
      failures: this.failures[this.active],
    };
  }

  /**
   * WS subscription slot control. On an 8GB laptop each websocket costs
   * ~1–2MB (framer buffers + viem emitter). We hard-cap concurrent subs;
   * callers that can't get a slot fall back to HTTP polling.
   */
  tryOpenWs(): boolean {
    if (this.wsCount >= this.maxWs) return false;
    this.wsCount++;
    return true;
  }
  closeWs(): void { this.wsCount = Math.max(0, this.wsCount - 1); }

  createWsClient(url: string): PublicClient | null {
    if (!this.tryOpenWs()) return null;
    try {
      // NB: viem clients expose no public emitter; the WS transport reconnects
      // internally and we release our slot when the caller drops the client.
      return createPublicClient({ transport: webSocket(url) });
    } catch {
      this.closeWs();
      return null;
    }
  }

  // ---------------------------------------------------------------- internals
  private pinging = false;                        // skip-if-busy guard

  private async pingAll(): Promise<void> {
    if (this.pinging) return;                     // overlapping ticks would double RPC load
    this.pinging = true;
    try {
      // Non-blocking: ≤3 tiny JSON-RPC calls in flight at once is fine even on
      // dual-core; each is network-bound, not CPU-bound. The indexed loop
      // avoids allocating an intermediate promise array via .map().
      const pings = new Array<Promise<void>>(this.clients.length);
      for (let i = 0; i < this.clients.length; i++) pings[i] = this.pingOne(i, this.clients[i]);
      await Promise.all(pings);
      this.electBest();
    } finally {
      this.pinging = false;
    }
  }

  private async pingOne(i: number, c: PublicClient): Promise<void> {
    const t0 = performance.now();
    try {
      await c.getBlockNumber();
      const dt = performance.now() - t0;
      this.rings[i].push(dt);
      this.ewma[i] = this.ewma[i] === 0 ? dt : this.ewma[i] * 0.8 + dt * 0.2; // EWMA α=0.2
      this.failures[i] = 0;
    } catch {
      this.failures[i]++;
      this.rings[i].push(Number.MAX_SAFE_INTEGER);     // poison sample → p95 blows up
      this.ewma[i] = this.ewma[i] === 0 ? 5_000 : Math.min(this.ewma[i] * 1.5, 30_000);
    }
  }

  private electBest(): void {
    let best = this.active;
    for (let i = 0; i < this.endpoints.length; i++) {
      if (this.failures[i] >= 3) continue;             // down → skip entirely
      const lat = this.ewma[i];
      if (lat <= this.ewma[best] && lat < this.thresholdMs) best = i;
    }
    // Hysteresis: only switch if the incumbent is over threshold OR the
    // challenger is ≥40% faster — prevents flapping every 10s tick.
    if (best !== this.active) {
      const incumbentBad = this.ewma[this.active] > this.thresholdMs || this.failures[this.active] >= 3;
      const muchBetter = this.ewma[best] < this.ewma[this.active] * 0.6;
      if (incumbentBad || muchBetter) {
        const old = this.active;
        this.active = best;
        this.onEvent?.(
          `[rpc] failover ${old}→${best} (${this.endpoints[old]} @${Math.round(this.ewma[old])}ms → ` +
          `${this.endpoints[best]} @${Math.round(this.ewma[best])}ms)`,
        );
      }
    }
    if (this.failures[this.active] >= 3) {
      this.onEvent?.(`[rpc] ALL ENDPOINTS DEGRADED — active=${this.activeUrl}`);
    }
  }
}
