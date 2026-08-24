import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getDb } from '../db';
import { env } from '../env';
import { logger } from '../logger';
import * as metrics from '../metrics';

/**
 * Publishes gameplay to LootGridActions, one transaction per action.
 *
 * The contract's own header covers why the chain records rather than decides.
 * This module's single hard rule is the operational one:
 *
 *   **Gameplay never waits on this.**
 *
 * `enqueue()` is a synchronous insert that swallows its own errors; a worker
 * drains the table out of band. If the RPC is down, the key is unfunded or the
 * chain is congested, rows accumulate and drain later. The game does not stall,
 * slow down, or fail. That asymmetry is deliberate — a public audit log is worth
 * having, but not worth a single dropped race.
 *
 * **Delivery is at-least-once, not exactly-once.** `dedupe_key` makes *enqueue*
 * idempotent, so a crash-and-replay inside the request path cannot queue the
 * same game fact twice. The send path cannot offer the same guarantee: a
 * transaction that is mined but whose response is lost gets retried under a
 * fresh nonce, and both land. Anything consuming these events must deduplicate
 * on the event contents — (player, zoneId, epoch, r, c) for a reveal,
 * (player, huntId) for an entry. Publishing a duplicate is the right trade
 * against silently losing a record.
 */

/**
 * ─────────────────────────── reveals are not relayed ─────────────────────────
 *
 * `LootGridActions` still exposes `recordReveal` and `recordRevealBatch`, and
 * this server no longer calls either. Private fog is the reason: a public,
 * per-player log of who uncovered which tile republishes the very map that
 * making the fog private was meant to withhold. An observer could reassemble
 * the pooled map from chain data and hand it back to everyone, which restores
 * free-riding, restores the standing subsidy against the hint market, and makes
 * fifty burner wallets cheap again.
 *
 * The deployed contract keeps the functions — it is immutable and other
 * deployments may want them — but nothing here can reach them, and `RelayKind`
 * has no 'reveal' member so nothing can start doing so by accident.
 *
 * What is still published is every claim the audit story actually rests on:
 * hunt commitments, hint sets and their truth flags, entries, resolutions and
 * payouts. Digs were the weakest of those and the only one that conflicts.
 */
export const ACTIONS_ABI = parseAbi([
  'function recordEntry(address player, bytes32 huntId, uint8 gameType)',
  'function recordResolution(address winner, bytes32 huntId, uint32 elapsedMs, uint16 racers)',
]);

// ------------------------------------------------------------------ encoding

/**
 * Packs a server-side string id (`ridge`, `ridge-1-3x4-a1b2c3`) into bytes32.
 *
 * Short ids go in as right-padded ASCII so an explorer shows something a human
 * can read. Anything that will not fit is keccak-hashed instead — still stable
 * and still unique, just opaque. The 31-byte threshold (not 32) leaves the
 * trailing NUL that makes the padded form unambiguously decodable.
 */
export function toBytes32Id(id: string): Hex {
  const bytes = Buffer.byteLength(id, 'utf8');
  return bytes <= 31 ? stringToHex(id, { size: 32 }) : keccak256(toHex(id));
}

/** Stable numeric codes for the on-chain enums. Append only — never reorder. */
const GAME_TYPES = ['math', 'memory', 'sequence', 'tap'] as const;

/** Unknown values map to 255 rather than throwing — an odd log beats a lost one. */
export const gameTypeCode = (t: string): number => {
  const i = (GAME_TYPES as readonly string[]).indexOf(t);
  return i === -1 ? 255 : i;
};

/** See the ABI note above for why there is no 'reveal'. */
export type RelayKind = 'entry' | 'resolution';

export interface EntryPayload {
  player: Address;
  huntId: Hex;
  gameType: number;
}
export interface ResolutionPayload {
  winner: Address;
  huntId: Hex;
  elapsedMs: number;
  racers: number;
}

type Payload = EntryPayload | ResolutionPayload;

interface Row {
  id: number;
  kind: RelayKind;
  payload: string;
  attempts: number;
}

// ------------------------------------------------------------------ enqueue

/**
 * Records an action for later publication.
 *
 * `dedupeKey` must be derived from the game fact, not from the call site: it is
 * the only thing standing between a crash-and-replay and a duplicate on-chain
 * record. A reveal is uniquely (zone, epoch, r, c); an entry is (hunt, player).
 *
 * Never throws. A relay failure is a missing log line, not a failed request.
 */
export function enqueue(kind: RelayKind, dedupeKey: string, payload: Payload): void {
  if (!env.RELAY_ENABLED) return;
  try {
    const now = Date.now();
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO relay_queue
           (kind, payload, dedupe_key, status, next_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(kind, JSON.stringify(payload), dedupeKey, now, now, now);

    if (res.changes > 0) metrics.relayEnqueued.inc({ kind });
    else metrics.relayDeduped.inc({ kind });
  } catch (err) {
    // Swallowed on purpose. See the module header.
    logger.warn({ err, kind, dedupeKey }, 'relay enqueue failed');
  }
}

// ------------------------------------------------------------------ transport
//
// The chain is reached through two functions rather than directly, so the queue
// state machine — dedupe, batching, backoff, dead-lettering, nonce recovery —
// can be tested for real without an RPC. The default implementations below are
// the only code that touches viem.

export type SendFn = (kind: RelayKind, payloads: Payload[]) => Promise<Hex>;
export type ConfirmFn = (hash: Hex) => Promise<boolean>;

let sendFn: SendFn;
let confirmFn: ConfirmFn;

let wallet: WalletClient | null = null;
let publicClient: PublicClient | null = null;
let relayerAddress: Address | null = null;
let signer: ReturnType<typeof privateKeyToAccount> | null = null;

function clients(): {
  wallet: WalletClient;
  pub: PublicClient;
  from: Address;
  account: ReturnType<typeof privateKeyToAccount>;
} {
  if (!wallet || !publicClient || !relayerAddress || !signer) {
    if (!env.RPC_URL || !env.RELAY_PRIVATE_KEY) {
      throw new Error('relayer misconfigured — env validation should have caught this');
    }
    signer = privateKeyToAccount(env.RELAY_PRIVATE_KEY as Hex);
    const transport = http(env.RPC_URL);
    publicClient = createPublicClient({ transport });
    wallet = createWalletClient({ account: signer, transport });
    relayerAddress = signer.address;
  }
  // `account` is the signer OBJECT; `from` is only its address, kept because the
  // nonce lookup and the log lines want a plain address. Passing the address to
  // writeContract makes viem treat the sender as a JSON-RPC account and call
  // `eth_sendTransaction` — which a public node cannot serve, because it holds
  // no keys. The object is what selects local signing.
  return { wallet, pub: publicClient, from: relayerAddress, account: signer };
}

/**
 * Nonce is tracked locally so transactions can be pipelined instead of waiting a
 * block each. It is resynced from the chain at start and after any send error,
 * because a desynced nonce silently wedges the entire queue.
 */
let nonce: number | null = null;

async function resyncNonce(): Promise<void> {
  const { pub, from } = clients();
  nonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
  logger.info({ nonce, relayer: from }, 'relayer nonce resynced');
}

/**
 * Fixed gas limit rather than an `eth_estimateGas` per transaction. These calls
 * emit a log and bump a counter — the cost is known and bounded, and skipping
 * estimation removes a round trip from the hot path.
 *
 * One number now that reveals are gone: the variable term existed only for
 * `recordRevealBatch`, and entries and resolutions are one row per transaction.
 */
const RELAY_GAS = 120_000n;

// ------------------------------------------------------------------ worker

let timer: NodeJS.Timeout | null = null;
let draining = false;
let stopped = true;

function claimDue(limit: number): Row[] {
  return getDb()
    .prepare(
      `SELECT id, kind, payload, attempts FROM relay_queue
        WHERE status = 'pending' AND next_at <= ?
        ORDER BY id LIMIT ?`,
    )
    .all(Date.now(), limit) as Row[];
}

function markSent(ids: number[], hash: Hex): void {
  const now = Date.now();
  const stmt = getDb().prepare(
    `UPDATE relay_queue SET status = 'sent', tx_hash = ?, updated_at = ? WHERE id = ?`,
  );
  getDb().transaction(() => {
    for (const id of ids) stmt.run(hash, now, id);
  })();
}

function markConfirmed(ids: number[]): void {
  const now = Date.now();
  const stmt = getDb().prepare(
    `UPDATE relay_queue SET status = 'confirmed', updated_at = ? WHERE id = ?`,
  );
  getDb().transaction(() => {
    for (const id of ids) stmt.run(now, id);
  })();
}

/**
 * Returns a row to the queue with exponential backoff, or parks it as `dead`
 * once it has burned through RELAY_MAX_ATTEMPTS.
 *
 * Dead rows are kept, never deleted. A row that cannot be published is exactly
 * the thing an operator needs to see, and `relay_dead` on the metrics endpoint
 * is the alert.
 */
function markFailed(rows: Row[], err: unknown): void {
  const now = Date.now();
  const message = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
  const stmt = getDb().prepare(
    `UPDATE relay_queue
        SET status = ?, attempts = ?, last_error = ?, next_at = ?, updated_at = ?
      WHERE id = ?`,
  );

  getDb().transaction(() => {
    for (const row of rows) {
      const attempts = row.attempts + 1;
      const dead = attempts >= env.RELAY_MAX_ATTEMPTS;
      // 2s, 4s, 8s … capped at 5 minutes.
      const backoff = Math.min(2_000 * 2 ** row.attempts, 300_000);
      stmt.run(dead ? 'dead' : 'pending', attempts, message, now + backoff, now, row.id);
      if (dead) metrics.relayDead.inc({ kind: row.kind });
    }
  })();
}

/**
 * The real transport. One transaction, nonce supplied locally.
 *
 * `payloads` is still an array and every branch reads `payloads[0]`. Batching
 * went out with the reveal relay — `recordRevealBatch` was the only multi-row
 * call the contract offers — but the queue's group-oriented shape is kept
 * because dead-lettering, receipt watching and requeueing all operate on groups,
 * and collapsing them to single rows would be a larger change than it looks.
 */
const chainSend: SendFn = async (kind, payloads) => {
  const { wallet: w, account } = clients();
  const n = nonce!;

  const common = {
    account,
    address: env.LOOTGRID_ACTIONS_ADDRESS as Address,
    abi: ACTIONS_ABI,
    chain: null,
    nonce: n,
    gas: RELAY_GAS,
  } as const;

  let hash: Hex;
  if (kind === 'entry') {
    const p = payloads[0] as EntryPayload;
    hash = await w.writeContract({
      ...common,
      functionName: 'recordEntry',
      args: [p.player, p.huntId, p.gameType],
    });
  } else {
    const p = payloads[0] as ResolutionPayload;
    hash = await w.writeContract({
      ...common,
      functionName: 'recordResolution',
      args: [p.winner, p.huntId, p.elapsedMs, p.racers],
    });
  }

  nonce = n + 1;
  return hash;
};

const chainConfirm: ConfirmFn = async hash => {
  const { pub } = clients();
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return receipt.status === 'success';
};

sendFn = chainSend;
confirmFn = chainConfirm;

/**
 * Swaps the transport. Tests only — passing `null` restores the real one.
 */
export function setTransportForTests(send: SendFn | null, confirm: ConfirmFn | null): void {
  sendFn = send ?? chainSend;
  confirmFn = confirm ?? chainConfirm;
}

/**
 * Confirmation runs detached from the send loop. Awaiting a receipt inline would
 * cap throughput at one transaction per block; here the loop keeps dispatching
 * while receipts land behind it.
 */
const inFlight = new Set<Promise<void>>();

function watchReceipt(group: Row[], hash: Hex): void {
  const kind = group[0]!.kind;
  const p = confirmFn(hash)
    .then(ok => {
      if (ok) {
        markConfirmed(group.map(r => r.id));
        metrics.relayConfirmed.inc({ kind }, group.length);
      } else {
        // Reverted on chain. Almost always `NotRelayer` after a key rotation —
        // retrying is right, and the backoff keeps it from spinning.
        markFailed(group, new Error(`reverted: ${hash}`));
        metrics.relayFailed.inc({ kind, reason: 'reverted' });
      }
    })
    .catch(err => {
      // Dropped or timed out. Requeue; the dedupe key makes a re-send safe even
      // if the original is mined later, because the row is the same row.
      markFailed(group, err);
      metrics.relayFailed.inc({ kind, reason: 'no_receipt' });
      logger.warn({ err, hash }, 'relay receipt not observed');
    })
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/** Test seam: resolves once every dispatched receipt has settled. */
export async function settle(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

export async function drain(): Promise<number> {
  if (draining || stopped) return 0;
  draining = true;
  let sent = 0;

  try {
    // Only the real transport carries a nonce; a stubbed one has nothing to sync.
    if (nonce === null && sendFn === chainSend) await resyncNonce();

    const rows = claimDue(env.RELAY_MAX_IN_FLIGHT);
    if (rows.length === 0) return 0;

    // One row per transaction. See `chainSend` — nothing batches any more.
    for (const group of rows.map(r => [r])) {
      try {
        const hash = await sendFn(
          group[0]!.kind,
          group.map(r => JSON.parse(r.payload) as Payload),
        );
        markSent(
          group.map(r => r.id),
          hash,
        );
        watchReceipt(group, hash);
        sent += group.length;
      } catch (err) {
        markFailed(group, err);
        metrics.relayFailed.inc({ kind: group[0]!.kind, reason: 'send' });
        // A send failure often means the local nonce disagrees with the chain.
        // Resync before the next tick rather than replaying a wedged sequence.
        nonce = null;
        break;
      }
    }
  } catch (err) {
    logger.error({ err }, 'relay drain failed');
    nonce = null;
  } finally {
    draining = false;
    updateDepthGauge();
  }

  return sent;
}

function updateDepthGauge(): void {
  try {
    const row = getDb()
      .prepare(
        `SELECT
           SUM(status = 'pending') AS pending,
           SUM(status = 'sent')    AS sent,
           SUM(status = 'dead')    AS dead
         FROM relay_queue`,
      )
      .get() as { pending: number | null; sent: number | null; dead: number | null };
    metrics.relayQueueDepth.set({ status: 'pending' }, row.pending ?? 0);
    metrics.relayQueueDepth.set({ status: 'sent' }, row.sent ?? 0);
    metrics.relayQueueDepth.set({ status: 'dead' }, row.dead ?? 0);
  } catch {
    /* gauges are not worth an exception */
  }
}

export function start(): void {
  if (!env.RELAY_ENABLED) {
    logger.info('relay disabled — gameplay will not be published on-chain');
    return;
  }
  stopped = false;

  // Anything left `sent` across a restart has an unwatched receipt. Return it to
  // `pending`; the on-chain record may end up duplicated for those few rows,
  // which is strictly better than losing them silently.
  const requeued = getDb()
    .prepare(`UPDATE relay_queue SET status = 'pending', next_at = ? WHERE status = 'sent'`)
    .run(Date.now()).changes;
  if (requeued > 0) logger.warn({ requeued }, 'requeued in-flight relay rows after restart');

  // Resolving the account here surfaces a malformed key at boot rather than on
  // the first reveal — but only the real transport has one.
  const from = sendFn === chainSend ? clients().from : null;
  logger.info(
    { relayer: from, contract: env.LOOTGRID_ACTIONS_ADDRESS },
    'relay started',
  );

  timer = setInterval(() => {
    void drain();
  }, env.RELAY_POLL_MS);
  timer.unref();
}

export function stop(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  nonce = null;
}

/** Test seam: clears memoised clients and queue state so env changes take effect. */
export function reset(): void {
  wallet = null;
  publicClient = null;
  relayerAddress = null;
  signer = null;
  nonce = null;
  draining = false;
  stopped = false;
  inFlight.clear();
  setTransportForTests(null, null);
}
