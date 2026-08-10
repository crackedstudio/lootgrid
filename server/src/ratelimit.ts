/**
 * Token buckets, in process. Redis would only be needed to share counters
 * across instances, and this deployment is one box.
 *
 * The boundary is kept narrow (`consume` / `reset`) so a shared backend can slot
 * in behind it without touching call sites.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

const buckets = new Map<string, Bucket>();

export interface Decision {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * @param key      caller-scoped identity, e.g. `tile:${playerId}`
 * @param limit    tokens per window
 * @param windowMs window length
 */
export function consume(key: string, limit: number, windowMs: number, cost = 1): Decision {
  const now = Date.now();
  const refillPerMs = limit / windowMs;

  let b = buckets.get(key);
  if (!b) {
    b = { tokens: limit, lastRefill: now, lastSeen: now };
    buckets.set(key, b);
  }

  // Lazy refill — no timers, and an idle key costs nothing until it is touched.
  const elapsed = now - b.lastRefill;
  if (elapsed > 0) {
    b.tokens = Math.min(limit, b.tokens + elapsed * refillPerMs);
    b.lastRefill = now;
  }
  b.lastSeen = now;

  if (b.tokens < cost) {
    const deficit = cost - b.tokens;
    return { ok: false, remaining: 0, retryAfterMs: Math.ceil(deficit / refillPerMs) };
  }

  b.tokens -= cost;
  return { ok: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
}

export function reset(key?: string): void {
  if (key) buckets.delete(key);
  else buckets.clear();
}

export const size = () => buckets.size;

/** Drops buckets nobody has touched, so a long uptime can't leak memory. */
export function sweep(idleMs = 10 * 60_000, now = Date.now()): number {
  let dropped = 0;
  for (const [key, b] of buckets) {
    if (now - b.lastSeen > idleMs) {
      buckets.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function start(): void {
  sweepTimer = setInterval(() => sweep(), 60_000);
  sweepTimer.unref?.();
}

export function stop(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
