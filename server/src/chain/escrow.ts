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
  'function refund(bytes32 huntId)',
  'function owed(address) view returns (uint256)',
  'function withdrawableAt(address) view returns (uint64)',
]);

/**
 * Which way the money is travelling.
 *
 * 'fund' fills a pot at hunt creation; 'refund' returns an unclaimed one to the
 * treasury once its epoch has closed. They share this queue because they share
 * everything that is hard about it — durability, backoff, receipt watching and
 * the dead-row alarm — and differ only in which contract call gets made.
 */
export type EscrowKind = 'fund' | 'refund';

interface Row {
  id: number;
  hunt_id: string;
  kind: string;
  amount: string;
  expires_at: number;
  attempts: number;
}

export interface FundingJob {
  kind: EscrowKind;
  huntId: Hex;
  /** Zero on a refund — the contract returns whatever the pot holds. */
  amount: bigint;
  /**
   * MILLISECOND epoch, as everywhere else in this server. Converted to seconds
   * at the chain boundary — see {@link chainSend}.
   *
   * On a refund this is the moment the pot becomes refundable rather than the
   * moment it stops being claimable. They are the same number; the sign of the
   * comparison against it is what differs.
   */
  expiresAt: number;
}

/**
 * ms → s for `block.timestamp`.
 *
 * Stated as its own function because getting it wrong is silent and expensive:
 * a millisecond value read as seconds lands in the year 55000, which makes
 * `fundHunt` succeed, `claim` succeed, and `refund` revert `NotExpired`
 * forever. The escape hatch that is supposed to survive a lost key or a
 * vanished operator would simply never open.
 */
export function toChainSeconds(msEpoch: number): bigint {
  return BigInt(Math.floor(msEpoch / 1000));
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
 * `expiresAt` is a **millisecond** epoch — the hunt's own, unmodified.
 *
 * Never throws — see the module header. A hunt with no prize is a worse hunt,
 * not a failed one.
 */
export function enqueue(huntId: string, amount: bigint, expiresAt: number): void {
  queue('fund', huntId, amount, expiresAt, Date.now());
}

/**
 * Queue an expired pot for return to the treasury.
 *
 * Called when a hunt expires or when its epoch closes underneath it. Safe to
 * call on a hunt that was never funded, was already claimed, or has been queued
 * before: the row is deduped on (hunt_id, kind), and the contract itself rejects
 * a refund of a settled or unfunded pot. Being wrong here costs one reverted
 * transaction, while *not* calling it strands real money on a dead map.
 *
 * `refundableAt` is a **millisecond** epoch — the hunt's own expiry. The worker
 * will not send before it, because `refund` reverts with NotExpired until
 * `block.timestamp` passes it.
 */
export function enqueueRefund(huntId: string, refundableAt: number): void {
  // A second past the on-chain expiry, not on it: `refund` requires strictly
  // greater than, and the two clocks are only loosely aligned. Sending early
  // wastes a transaction and burns an attempt off the retry budget.
  queue('refund', huntId, 0n, refundableAt, refundableAt + 1_000);
}

function queue(
  kind: EscrowKind,
  huntId: string,
  amount: bigint,
  expiresAt: number,
  nextAt: number,
): void {
  if (!enabled()) return;
  try {
    const now = Date.now();
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO escrow_queue
           (hunt_id, kind, amount, expires_at, status, next_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(huntId, kind, amount.toString(), expiresAt, nextAt, now, now);

    if (res.changes > 0) metrics.escrowEnqueued.inc();
    else metrics.escrowDeduped.inc();
  } catch (err) {
    logger.warn({ err, huntId, kind }, 'escrow enqueue failed');
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

/**
 * Reading takes no key.
 *
 * Kept separate from {@link clients} on purpose: balances are readable whenever
 * an escrow address and an RPC exist, and requiring the treasury key for a
 * `view` call would mean a deployment that funds pots elsewhere could not tell
 * a winner whether their prize had landed.
 */
function readClient() {
  if (!publicClient) {
    if (!env.RPC_URL) {
      throw new Error('escrow reads misconfigured — check readable() first');
    }
    publicClient = createPublicClient({ transport: http(env.RPC_URL) });
  }
  return publicClient;
}

function clients() {
  if (!wallet || !treasury) {
    if (!env.RPC_URL || !env.ESCROW_TREASURY_PRIVATE_KEY) {
      throw new Error('escrow funding misconfigured — env validation should have caught this');
    }
    const account = privateKeyToAccount(env.ESCROW_TREASURY_PRIVATE_KEY as Hex);
    wallet = createWalletClient({ account, transport: http(env.RPC_URL) });
    treasury = account.address;
  }
  return { wallet, pub: readClient(), from: treasury };
}

const chainSend: SendFn = async job => {
  const { wallet: w, from } = clients();
  const contract = {
    account: from,
    address: env.LOOTGRID_ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    chain: null,
  } as const;

  if (job.kind === 'refund') {
    return w.writeContract({
      ...contract,
      functionName: 'refund',
      // Clears two slots and makes one transfer — strictly less work than
      // funding, but the same fixed-gas discipline applies.
      args: [job.huntId],
      gas: 120_000n,
    });
  }

  return w.writeContract({
    ...contract,
    functionName: 'fundHunt',
    args: [job.huntId, job.amount, toChainSeconds(job.expiresAt)],
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

// ------------------------------------------------------------------ balances

/**
 * What a winner is owed, and when they may take it.
 *
 * Read rather than remembered. The contract is the only thing that knows
 * whether a claim transaction actually landed — the server issued the
 * attestation but never saw the submission, and a UI that guessed would tell a
 * player their prize was ready when it was not.
 */
export interface Balance {
  /** Token base units. Zero once withdrawn, and zero before a claim lands. */
  owed: bigint;
  /** Seconds epoch. `withdraw` reverts until this passes. */
  withdrawableAt: number;
}

export type ReadBalanceFn = (winner: Address) => Promise<Balance>;

const chainReadBalance: ReadBalanceFn = async winner => {
  const pub = readClient();
  const contract = { address: env.LOOTGRID_ESCROW_ADDRESS as Address, abi: ESCROW_ABI } as const;
  const [owed, withdrawableAt] = await Promise.all([
    pub.readContract({ ...contract, functionName: 'owed', args: [winner] }),
    pub.readContract({ ...contract, functionName: 'withdrawableAt', args: [winner] }),
  ]);
  return { owed, withdrawableAt: Number(withdrawableAt) };
};

let readBalanceFn: ReadBalanceFn = chainReadBalance;

export function setBalanceReaderForTests(fn: ReadBalanceFn | null): void {
  readBalanceFn = fn ?? chainReadBalance;
}

/** Whether balances can be read. Needs an address and an RPC, but no key. */
export function readable(): boolean {
  return Boolean(env.LOOTGRID_ESCROW_ADDRESS && env.RPC_URL);
}

export function readBalance(winner: Address): Promise<Balance> {
  return readBalanceFn(winner);
}

// ------------------------------------------------------------------ queue

function claimDue(limit: number): Row[] {
  return getDb()
    .prepare(
      `SELECT id, hunt_id, kind, amount, expires_at, attempts FROM escrow_queue
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
    // A dead fund row is a hunt that will never carry a prize; a dead refund row
    // is money left sitting in a pot nobody can win. Both need a human, and the
    // second is the one that quietly accumulates.
    logger.error(
      { huntId: row.hunt_id, kind: row.kind, attempts, err },
      row.kind === 'refund' ? 'escrow refund abandoned — pot stranded' : 'escrow funding abandoned',
    );
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
          kind: row.kind === 'refund' ? 'refund' : 'fund',
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
