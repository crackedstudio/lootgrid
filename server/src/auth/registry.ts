import { createPublicClient, http, parseAbi, type Address, type PublicClient } from 'viem';
import { env } from '../env';
import { logger } from '../logger';

const ABI = parseAbi([
  'function sessionKeyOf(address player) view returns (address)',
  'function isBound(address player, address sessionKey) view returns (bool)',
]);

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
 * Reads the bound session key, cached for REGISTRY_CACHE_MS.
 *
 * The cache is why a key rotation is not instant: after `clear()` or a rebind,
 * the old key keeps working for up to the TTL. That is the price of not doing
 * an RPC round trip on every request, and one minute is short enough that it
 * cannot be meaningfully exploited — an attacker with the old key already had
 * it before the rotation.
 */
export async function sessionKeyOf(player: Address, now = Date.now()): Promise<Address | null> {
  const cacheKey = player.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < env.REGISTRY_CACHE_MS) return hit.key;

  const address = env.PLAYER_REGISTRY_ADDRESS as Address | undefined;
  if (!address) throw new Error('PLAYER_REGISTRY_ADDRESS is required when AUTH_MODE=chain');

  const raw = await getClient().readContract({
    address,
    abi: ABI,
    functionName: 'sessionKeyOf',
    args: [player],
  });

  const key = raw === '0x0000000000000000000000000000000000000000' ? null : (raw as Address);
  cache.set(cacheKey, { key, at: now });
  return key;
}

/** Drops a cached binding so a rotation takes effect immediately. */
export function invalidate(player: string): void {
  cache.delete(player.toLowerCase());
}

export function clearCache(): void {
  cache.clear();
}

export const cacheSize = () => cache.size;

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
