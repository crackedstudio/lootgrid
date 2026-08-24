import { createPublicClient, http, parseAbi, type Address, type PublicClient } from 'viem';
import { env } from '../env';
import { logger } from '../logger';

export const ABI = parseAbi([
  'function sessionKeyOf(address player) view returns (address)',
  'function isBound(address player, address sessionKey) view returns (bool)',
  'event SessionKeyBound(address indexed player, address indexed sessionKey, uint64 at)',
  'event SessionKeyCleared(address indexed player, address indexed sessionKey, uint64 at)',
]);

// ⚠️ These signatures are the topic0 preimage. Changing a parameter list in the
// contract — even adding `indexed`, which does not move the parameter — changes
// the hash and silently kills the subscription: no error, no log, just nothing.
// `abiMatchesContract.test.ts` diffs these against the Solidity source so the
// next drift fails a test instead of disabling revocation in production.

/**
 * No `chain` object is passed deliberately. These are read-only `eth_call`s, so
 * a chain definition buys nothing, and pinning one means tracking whichever id
 * Celo Sepolia settles on across viem versions.
 */
let client: PublicClient | null = null;
function getClient(): PublicClient {
  if (!client) {
    if (!env.RPC_URL) throw new Error('RPC_URL is required when AUTH_MODE=chain');
    client = createPublicClient({ transport: http(env.RPC_URL) });
  }
  return client;
}

interface Entry {
  key: Address | null;
  at: number;
}
const cache = new Map<string, Entry>();

/**
 * Bumped on every invalidation. A read-through write straddles an `await`, so an
 * invalidation that lands mid-flight would otherwise be undone by the in-flight
 * read writing back the pre-revocation value — with a fresh full-length TTL.
 */
let generation = 0;

/** Negative results expire far sooner — see `sessionKeyOf`. */
const ttlFor = (e: Entry) =>
  e.key === null ? env.REGISTRY_NEGATIVE_CACHE_MS : env.REGISTRY_CACHE_MS;

/**
 * Reads the bound session key.
 *
 * Two TTLs, deliberately. A positive result is cached for REGISTRY_CACHE_MS; a
 * negative one ("no binding") for far less, because an unauthenticated request
 * naming a not-yet-bound address would otherwise lock that player out of their
 * own first login for the full window.
 *
 * The cache is no longer the sole revocation path: `watchRevocations()`
 * subscribes to the contract's events and evicts on rotation, so the TTL is now
 * a backstop for a dropped subscription rather than the mechanism itself.
 */
export async function sessionKeyOf(player: Address, now = Date.now()): Promise<Address | null> {
  const cacheKey = player.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < ttlFor(hit)) return hit.key;

  const address = env.PLAYER_REGISTRY_ADDRESS as Address | undefined;
  if (!address) throw new Error('PLAYER_REGISTRY_ADDRESS is required when AUTH_MODE=chain');

  const gen = generation;
  const raw = await getClient().readContract({
    address,
    abi: ABI,
    functionName: 'sessionKeyOf',
    args: [player],
  });

  const key = raw === '0x0000000000000000000000000000000000000000' ? null : (raw as Address);

  // Only cache if no invalidation happened while this read was in flight —
  // otherwise a revocation that arrived mid-request gets silently reverted.
  // Stamped at completion, not at request start, so the TTL cannot be
  // back-dated to before the rotation it missed.
  if (gen === generation) cache.set(cacheKey, { key, at: Date.now() });
  return key;
}

/** Drops a cached binding so a rotation takes effect immediately. */
export function invalidate(player: string): void {
  cache.delete(player.toLowerCase());
  generation += 1;
}

export function clearCache(): void {
  cache.clear();
  generation += 1;
}

export const cacheSize = () => cache.size;

/**
 * Evicts entries nobody has touched.
 *
 * Without this the cache is an unbounded Map keyed by an attacker-chosen,
 * unauthenticated address — every sprayed request left a permanent entry.
 * `ratelimit.ts` has always swept its buckets for exactly this reason.
 */
export function sweep(now = Date.now()): number {
  let dropped = 0;
  for (const [key, entry] of cache) {
    if (now - entry.at > ttlFor(entry)) {
      cache.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

let sweepTimer: NodeJS.Timeout | null = null;
let unwatch: Array<() => void> = [];

/**
 * Subscribes to the contract's own revocation signals.
 *
 * This is what makes `clear()` mean what its NatSpec says. Previously the only
 * mechanism was the TTL, so a revoked key kept authenticating for up to a
 * minute — precisely in the scenario `clear()` exists to handle.
 */
export function watchRevocations(): void {
  if (env.AUTH_MODE !== 'chain') return;
  const address = env.PLAYER_REGISTRY_ADDRESS as Address | undefined;
  if (!address) return;

  const onLogs = (logs: Array<{ args: { player?: Address } }>) => {
    for (const log of logs) {
      if (log.args.player) {
        invalidate(log.args.player);
        logger.info({ player: log.args.player }, 'session key rotated — cache invalidated');
      }
    }
  };

  // ─────────────────────── why not watchContractEvent ───────────────────────
  //
  // viem's watcher polls `eth_getFilterChanges` against a filter made by
  // `eth_newFilter` — and that filter is state held by ONE node. A public
  // endpoint like forno.celo.org is a load balancer, so the filter is created
  // on one node and polled on another, which answers `filter not found`
  // forever. `poll: true` does not help: it selects the filter path, and only
  // falls back to getLogs when filter *creation* fails, which here it does not.
  //
  // The failure is quiet in the worst way — the process keeps running while the
  // watcher never fires, so a revoked key authenticates until the TTL expires.
  // That is exactly what this subscription exists to prevent.
  //
  // getLogs over an explicit block range is stateless, so any node can answer
  // it. We track our own cursor, which also means a restart or a dropped poll
  // resumes from the last block seen rather than losing the gap silently.
  let cursor: bigint | null = null;

  const poll = async (): Promise<void> => {
    try {
      const latest = await getClient().getBlockNumber();
      if (cursor === null) cursor = latest; // first tick: start from now, not genesis
      if (latest <= cursor) return;

      // Bounded so a long stall cannot ask a public node for a huge range.
      const from = cursor + 1n;
      const to = latest - from > 500n ? from + 500n : latest;

      for (const eventName of ['SessionKeyBound', 'SessionKeyCleared'] as const) {
        const logs = await getClient().getContractEvents({
          address,
          abi: ABI,
          eventName,
          fromBlock: from,
          toBlock: to,
        });
        if (logs.length > 0) onLogs(logs as never);
      }
      cursor = to;
    } catch (err) {
      // Transient RPC trouble is ordinary. The cursor is not advanced, so the
      // next tick re-reads the same range rather than skipping it.
      logger.warn({ err }, 'registry event poll failed — will retry');
    }
  };

  const timer = setInterval(() => void poll(), 4_000);
  timer.unref?.();
  unwatch.push(() => clearInterval(timer));
  void poll();

  logger.info({ address }, 'watching registry for key rotations');
}

export function start(): void {
  sweepTimer = setInterval(() => {
    const dropped = sweep();
    if (dropped > 0) logger.debug({ dropped }, 'swept registry cache');
  }, 60_000);
  sweepTimer.unref?.();
  watchRevocations();
}

export function stop(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const off of unwatch) {
    try {
      off();
    } catch {
      /* already torn down */
    }
  }
  unwatch = [];
}

/** Called at boot so a misconfigured RPC or address fails loudly, not per-request. */
export async function checkReachable(): Promise<boolean> {
  if (env.AUTH_MODE !== 'chain') return true;
  try {
    await getClient().getBlockNumber();
    logger.info({ rpc: env.RPC_URL, registry: env.PLAYER_REGISTRY_ADDRESS }, 'registry reachable');
    return true;
  } catch (err) {
    logger.error({ err, rpc: env.RPC_URL }, 'registry RPC unreachable');
    return false;
  }
}
