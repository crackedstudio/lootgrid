import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getDb } from '../db';
import { env } from '../env';
import { logger } from '../logger';
import * as metrics from '../metrics';

/**
 * Funds hunt prizes into LootGridEscrow, one pot per hunt.
 *
 * ─────────────────────────── the rule, unchanged ───────────────────────────
 *
 *   **Gameplay never waits on this.**
 *
 * `enqueue` is a synchronous insert that swallows its own errors; a worker
 * drains the table out of band. If the RPC is down, the treasury is empty or the
 * chain is congested, hunts still open and play normally — they simply have no
 * prize attached, and a claim reverts `NotFunded` until the pot lands. A funding
 * outage must never stop a race.
 *
 * ─────────────────────────── but money is not a log line ───────────────────
 *
 * The relayer publishes records, so at-least-once delivery is merely noisy there
 * — a duplicate event is deduped by an indexer. Here a duplicate would be a
 * second pot. Two things prevent it: `hunt_id` is UNIQUE in the outbox, and the
 * contract rejects a second `fundHunt` for the same id with `AlreadyFunded`. So
 * a retry after a lost response is safe: it either lands once or reverts, and a
 * revert is treated as terminal rather than retried forever.
 *
 * ─────────────────────────── the treasury key ───────────────────────────
 *
 * This is the only key on the server that holds spendable money. The relayer key
 * writes false logs if it leaks; the payout attestor can pay attested winners up
 * to the caps; this one *is* the float. Keep the balance small and top it up on
 * a schedule — the exposure is exactly what sits in it, and nothing in the
 * contract can bound that.
 */

export const ESCROW_ABI = parseAbi([
  'function fundHunt(bytes32 huntId, uint256 amount, uint64 expiresAt)',
]);

interface Row {
  id: number;
  hunt_id: string;
  amount: string;
  expires_at: number;
  attempts: number;
}

export interface FundingJob {
  huntId: Hex;
  amount: bigint;
  expiresAt: number;
}

// ------------------------------------------------------------------ enqueue

export function enabled(): boolean {
  return Boolean(
    env.ESCROW_FUNDING_ENABLED && env.LOOTGRID_ESCROW_ADDRESS && env.ESCROW_TREASURY_PRIVATE_KEY,
  );
}

/**
 * Queue a pot for funding. Called inside the transaction that creates the hunt,
 * so a hunt and its funding intent are recorded together or not at all.
 *
 * Never throws — see the module header. A hunt with no prize is a worse hunt,
 * not a failed one.
 */
export function enqueue(huntId: string, amount: bigint, expiresAt: number): void {
  if (!enabled()) return;
  try {
    const now = Date.now();
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO escrow_queue
           (hunt_id, amount, expires_at, status, next_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(huntId, amount.toString(), expiresAt, now, now, now);

    if (res.changes > 0) metrics.escrowEnqueued.inc();
    else metrics.escrowDeduped.inc();
  } catch (err) {
    logger.warn({ err, huntId }, 'escrow enqueue failed — hunt opens unfunded');
  }
}

// ------------------------------------------------------------------ transport
//
// Same seam as the relayer: the chain is reached through two functions so the
// queue's state machine can be tested for real without an RPC.

export type SendFn = (job: FundingJob) => Promise<Hex>;
export type ConfirmFn = (hash: Hex) => Promise<boolean>;

let sendFn: SendFn;
let confirmFn: ConfirmFn;

let wallet: ReturnType<typeof createWalletClient> | null = null;
let publicClient: ReturnType<typeof createPublicClient> | null = null;
let treasury: Address | null = null;

function clients() {
  if (!wallet || !publicClient || !treasury) {
    if (!env.RPC_URL || !env.ESCROW_TREASURY_PRIVATE_KEY) {
      throw new Error('escrow funding misconfigured — env validation should have caught this');
    }
    const account = privateKeyToAccount(env.ESCROW_TREASURY_PRIVATE_KEY as Hex);
    const transport = http(env.RPC_URL);
    publicClient = createPublicClient({ transport });
    wallet = createWalletClient({ account, transport });
    treasury = account.address;
  }
  return { wallet, pub: publicClient, from: treasury };
}

const chainSend: SendFn = async job => {
  const { wallet: w, from } = clients();
  return w.writeContract({
    account: from,
    address: env.LOOTGRID_ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    chain: null,
    functionName: 'fundHunt',
    args: [job.huntId, job.amount, BigInt(job.expiresAt)],
    // fundHunt is one SSTORE-heavy write plus a transfer; fixed rather than
    // estimated, for the same reason the relayer skips estimation.
    gas: 200_000n,
  });
};

const chainConfirm: ConfirmFn = async hash => {
  const { pub } = clients();
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return receipt.status === 'success';
};

sendFn = chainSend;
confirmFn = chainConfirm;

/** Swaps the transport. Tests only — `null` restores the real one. */
export function setTransportForTests(send: SendFn | null, confirm: ConfirmFn | null): void {
  sendFn = send ?? chainSend;
  confirmFn = confirm ?? chainConfirm;
}

// ------------------------------------------------------------------ queue

function claimDue(limit: number): Row[] {
  return getDb()
    .prepare(
      `SELECT id, hunt_id, amount, expires_at, attempts FROM escrow_queue
       WHERE status = 'pending' AND next_at <= ?
       ORDER BY id LIMIT ?`,
    )
    .all(Date.now(), limit) as Row[];
}

function markSent(id: number, hash: Hex): void {
  getDb()
    .prepare(`UPDATE escrow_queue SET status='sent', tx_hash=?, updated_at=? WHERE id=?`)
    .run(hash, Date.now(), id);
}

function markConfirmed(id: number): void {
  getDb()
    .prepare(`UPDATE escrow_queue SET status='confirmed', updated_at=? WHERE id=?`)
    .run(Date.now(), id);
}

/**
 * Requeue with backoff, or park the row for a human.
 *
 * `terminal` is set when the chain has told us the call can never succeed —
 * `AlreadyFunded` on a pot that already exists, or a cap rejection. Retrying
 * those forever burns gas and buries the genuinely transient failures in noise.
 */
function markFailed(row: Row, err: unknown, terminal = false): void {
  const attempts = row.attempts + 1;
  const dead = terminal || attempts >= env.ESCROW_MAX_ATTEMPTS;
  const backoff = Math.min(60_000 * 2 ** (attempts - 1), 60 * 60_000);

  getDb()
    .prepare(
      `UPDATE escrow_queue
         SET status = ?, attempts = ?, last_error = ?, next_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      dead ? 'dead' : 'pending',
      attempts,
      String(err).slice(0, 500),
      Date.now() + backoff,
      Date.now(),
      row.id,
    );

  if (dead) {
    metrics.escrowDead.inc();
    // A dead row is a hunt that will never carry a prize. Someone has to look.
    logger.error({ huntId: row.hunt_id, attempts, err }, 'escrow funding abandoned');
  }
}

const inFlight = new Set<Promise<void>>();

function watchReceipt(row: Row, hash: Hex): void {
  const p = confirmFn(hash)
    .then(ok => {
      if (ok) {
        markConfirmed(row.id);
        metrics.escrowFunded.inc();
      } else {
        // Reverted. Most likely AlreadyFunded (a retry whose original landed) or
        // a cap rejection — neither improves by trying again.
        markFailed(row, new Error(`reverted: ${hash}`), true);
        metrics.escrowFailed.inc({ reason: 'reverted' });
      }
    })
    .catch(err => {
      // Dropped or timed out. Retry is safe: hunt_id is unique in the outbox and
      // the contract rejects a second pot, so at worst the retry reverts.
      markFailed(row, err);
      metrics.escrowFailed.inc({ reason: 'no_receipt' });
      logger.warn({ err, hash, huntId: row.hunt_id }, 'escrow receipt not observed');
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

let draining = false;
let stopped = true;
let timer: NodeJS.Timeout | null = null;

export async function drain(): Promise<number> {
  if (draining || stopped) return 0;
  draining = true;
  let sent = 0;

  try {
    const rows = claimDue(env.ESCROW_MAX_IN_FLIGHT);
    for (const row of rows) {
      try {
        const hash = await sendFn({
          huntId: row.hunt_id as Hex,
          amount: BigInt(row.amount),
          expiresAt: row.expires_at,
        });
        markSent(row.id, hash);
        watchReceipt(row, hash);
        sent += 1;
      } catch (err) {
        markFailed(row, err);
        metrics.escrowFailed.inc({ reason: 'send' });
      }
    }
  } finally {
    draining = false;
    updateDepthGauge();
  }

  return sent;
}

function updateDepthGauge(): void {
  try {
    const rows = getDb()
      .prepare(`SELECT status, COUNT(*) AS n FROM escrow_queue GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const seen = new Set(rows.map(r => r.status));
    for (const r of rows) metrics.escrowQueueDepth.set({ status: r.status }, r.n);
    for (const s of ['pending', 'sent', 'confirmed', 'dead']) {
      if (!seen.has(s)) metrics.escrowQueueDepth.set({ status: s }, 0);
    }
  } catch {
    // Metrics must never break the worker.
  }
}

export function start(): void {
  if (!enabled()) {
    logger.info('escrow funding disabled — hunts will open without prizes');
    return;
  }
  stopped = false;
  timer = setInterval(() => {
    void drain().catch(err => logger.error({ err }, 'escrow drain failed'));
  }, env.ESCROW_POLL_MS);
  timer.unref?.();
  logger.info({ pollMs: env.ESCROW_POLL_MS }, 'escrow funding worker started');
}

export function stop(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test-only: clears module state so a fresh world starts clean. */
export function reset(): void {
  stop();
  stopped = true;
  draining = false;
  wallet = null;
  publicClient = null;
  treasury = null;
  inFlight.clear();
}

/** Test-only: allows drain() to run without start()'s interval. */
export function unstopForTests(): void {
  stopped = false;
}
