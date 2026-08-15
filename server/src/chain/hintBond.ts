import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { env } from '../env';
import { logger } from '../logger';

/**
 * Whether a seller has money at risk.
 *
 * ─────────────────────────── one read, one seam ─────────────────────────────
 *
 * Same shape as `hintEscrow.ts`: the chain is reached through a single function
 * so the listing path can be tested for real without an RPC.
 *
 * ─────────────────────────── it fails closed ────────────────────────────────
 *
 * An unreachable RPC refuses the listing. That is the uncomfortable direction
 * and it is the right one: failing open means the bond requirement is bypassed
 * by anyone who can make this read fail, which turns a spending attack on the
 * RPC into a licence to list unbonded. Failing closed costs a seller a retry
 * on a path that is not time-critical — nobody is racing a clock to publish a
 * hint for sale.
 *
 * The refusal is a *distinct* error from "you have no bond", for the same reason
 * `readTrade` throws rather than reporting `None`: "you are not bonded" and "we
 * could not find out" must not look the same to the seller staring at the
 * message or to the operator reading the logs.
 *
 * ─────────────────────────── the cache is asymmetric ────────────────────────
 *
 * Positives are cached briefly, negatives never. A seller who has just posted a
 * bond must be able to list immediately — making them wait out a TTL for money
 * they have already committed is the kind of small cruelty that makes a feature
 * feel broken. The cost of the asymmetry is that a seller slashed in the last
 * few seconds may still list once, which is bounded, recoverable, and much
 * cheaper than the alternative.
 */

export const HINT_BOND_READ_ABI = parseAbi([
  'function canList(address seller) view returns (bool)',
  'function bonded(address seller) view returns (uint256)',
]);

export type CanListFn = (seller: Address) => Promise<boolean>;

/**
 * Whether the bond is enforced at all.
 *
 * No configured address means the requirement is off and listing behaves exactly
 * as it did before the bond existed — the same switch every other chain-backed
 * feature here uses. An operator turns it on by deploying and setting it.
 */
export function enabled(): boolean {
  return Boolean(env.HINT_BOND_ADDRESS && env.RPC_URL);
}

let publicClient: ReturnType<typeof createPublicClient> | null = null;

function client() {
  if (!publicClient) {
    if (!env.RPC_URL) {
      throw new Error('hint bond misconfigured — env validation should have caught this');
    }
    publicClient = createPublicClient({ transport: http(env.RPC_URL) });
  }
  return publicClient;
}

const chainRead: CanListFn = async seller =>
  client().readContract({
    address: env.HINT_BOND_ADDRESS as Address,
    abi: HINT_BOND_READ_ABI,
    functionName: 'canList',
    args: [seller],
  });

let readFn: CanListFn = chainRead;

/** Swaps the transport. Tests only — `null` restores the real one. */
export function setReaderForTests(fn: CanListFn | null): void {
  readFn = fn ?? chainRead;
  cache.clear();
}

/** How long a seller stays known-good without asking again. */
export const CACHE_MS = 30_000;

const cache = new Map<string, number>();

/**
 * May this seller list?
 *
 * Throws when the answer cannot be obtained. Callers turn that into a refusal
 * with its own error code rather than treating it as a `false` — see the header.
 */
export async function canList(seller: string, now = Date.now()): Promise<boolean> {
  if (!enabled()) return true;

  const key = seller.toLowerCase();
  const goodUntil = cache.get(key);
  if (goodUntil !== undefined && goodUntil > now) return true;

  const allowed = await readFn(seller as Address);
  // Only the yes is remembered. See the header for why the no is not.
  if (allowed) cache.set(key, now + CACHE_MS);
  else cache.delete(key);

  return allowed;
}

/** Drop a seller's cached standing. Called after anything that could change it. */
export function forget(seller: string): void {
  cache.delete(seller.toLowerCase());
}

export function reset(): void {
  cache.clear();
  publicClient = null;
}

/** Diagnostics only. Never a gate — `canList` is the contract's own answer. */
export async function bondedAmount(seller: string): Promise<bigint> {
  if (!enabled()) return 0n;
  try {
    return await client().readContract({
      address: env.HINT_BOND_ADDRESS as Address,
      abi: HINT_BOND_READ_ABI,
      functionName: 'bonded',
      args: [seller as Address],
    });
  } catch (err) {
    logger.warn({ err, seller }, 'hint bond balance read failed');
    return 0n;
  }
}
