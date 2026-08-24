import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { getDb } from '../db';
import { env } from '../env';
import { freshWorld, teardownWorld } from '../testing/harness';
import * as escrow from './escrow';
import * as attestor from './attestor';
import { toBytes32Id } from './relayer';

/**
 * The escrow outbox.
 *
 * Driven through the transport seam rather than an RPC, so the state machine
 * that actually matters — dedupe, backoff, dead-lettering, and the distinction
 * between a transient failure and a terminal one — is exercised for real.
 *
 * The property under test throughout is that **this moves money exactly once or
 * not at all**. At-least-once delivery is fine for a log line and expensive
 * here, so a retry must never produce a second pot.
 */

const mut = env as {
  ESCROW_FUNDING_ENABLED: boolean;
  LOOTGRID_ESCROW_ADDRESS?: string;
  ESCROW_TREASURY_PRIVATE_KEY?: string;
  ESCROW_MAX_ATTEMPTS: number;
  ESCROW_MAX_IN_FLIGHT: number;
};

const original = { ...mut };
const HASH = '0xabc' as Hex;
const HUNT = 'ridge-1-3x4-aaa';
/** What the chain must actually receive: bytes32, never the readable id. */
const HUNT32 = toBytes32Id(HUNT);

function rows() {
  return getDb()
    .prepare(
      // `kind` included deliberately: without it every `r.kind === ...` filter
      // in this file silently matches nothing, and a test that asserts an empty
      // result passes for the wrong reason.
      'SELECT id, hunt_id, kind, amount, status, attempts, tx_hash FROM escrow_queue ORDER BY id',
    )
    .all() as Array<{
    id: number;
    hunt_id: string;
    kind: string;
    amount: string;
    status: string;
    attempts: number;
    tx_hash: string | null;
  }>;
}

/** Clears rows the seeded world queued, so each test starts from a known state. */
function clearQueue() {
  getDb().prepare('DELETE FROM escrow_queue').run();
}

beforeEach(() => {
  mut.ESCROW_FUNDING_ENABLED = true;
  mut.LOOTGRID_ESCROW_ADDRESS = '0x00000000000000000000000000000000000000e5';
  mut.ESCROW_TREASURY_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  mut.ESCROW_MAX_ATTEMPTS = 3;
  mut.ESCROW_MAX_IN_FLIGHT = 10;
  freshWorld();
  clearQueue();
  escrow.unstopForTests();
});

afterEach(() => {
  escrow.setTransportForTests(null, null);
  Object.assign(mut, original);
  teardownWorld();
});

describe('enqueue', () => {
  it('queues a pot', () => {
    escrow.enqueue(HUNT, 500_000_000_000_000_000n, Date.now() + 1000);
    const [row] = rows();
    expect(row!.hunt_id).toBe(HUNT);
    expect(row!.status).toBe('pending');
    // Stored as text: 5e17 exceeds what SQLite's INTEGER holds exactly.
    expect(row!.amount).toBe('500000000000000000');
  });

  it('is idempotent per hunt — one pot, never two', () => {
    escrow.enqueue(HUNT, 1n, Date.now() + 1000);
    escrow.enqueue(HUNT, 999n, Date.now() + 1000);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.amount).toBe('1');
  });

  it('is a no-op when funding is off', () => {
    mut.ESCROW_FUNDING_ENABLED = false;
    escrow.enqueue(HUNT, 1n, Date.now() + 1000);
    expect(rows()).toHaveLength(0);
  });

  it('never throws, even with the table gone', () => {
    // Gameplay has already succeeded by the time this runs. A funding failure is
    // a hunt without a prize, never a failed request.
    getDb().prepare('DROP TABLE escrow_queue').run();
    expect(() => escrow.enqueue(HUNT, 1n, Date.now() + 1000)).not.toThrow();
  });
});

describe('draining', () => {
  it('sends a pending pot and confirms it', async () => {
    // Typed as SendFn rather than inferred: `async () => HASH` infers a
    // zero-arg signature, so the recorded call args would type as `[]`.
    const send = vi.fn<escrow.SendFn>(async () => HASH);
    escrow.setTransportForTests(send, async () => true);

    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    expect(await escrow.drain()).toBe(1);
    await escrow.settle();

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      huntId: HUNT32,
      amount: 5n,
      expiresAt: 1_800_000_000,
    });
    expect(rows()[0]).toMatchObject({ status: 'confirmed', tx_hash: HASH });
  });

  it('does not resend a row already sent', async () => {
    const send = vi.fn(async () => HASH);
    escrow.setTransportForTests(send, async () => true);

    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    await escrow.drain();
    await escrow.settle();
    await escrow.drain();

    expect(send).toHaveBeenCalledOnce();
  });

  it('respects the in-flight limit', async () => {
    mut.ESCROW_MAX_IN_FLIGHT = 2;
    const send = vi.fn(async () => HASH);
    escrow.setTransportForTests(send, async () => true);

    for (let i = 0; i < 5; i++) escrow.enqueue(`hunt-${i}`, 1n, 1_800_000_000);
    expect(await escrow.drain()).toBe(2);
    await escrow.settle();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('failure handling', () => {
  it('retries a send failure with backoff', async () => {
    escrow.setTransportForTests(async () => {
      throw new Error('rpc down');
    }, async () => true);

    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    await escrow.drain();

    const [row] = rows();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
  });

  it('gives up after the configured attempts and parks the row', async () => {
    escrow.setTransportForTests(async () => {
      throw new Error('rpc down');
    }, async () => true);
    escrow.enqueue(HUNT, 5n, 1_800_000_000);

    for (let i = 0; i < mut.ESCROW_MAX_ATTEMPTS; i++) {
      // Backoff pushes next_at forward, so move the clock rather than sleeping.
      getDb().prepare('UPDATE escrow_queue SET next_at = 0').run();
      await escrow.drain();
    }

    const [row] = rows();
    expect(row!.status).toBe('dead');
    expect(row!.attempts).toBe(mut.ESCROW_MAX_ATTEMPTS);
  });

  it('treats a revert as terminal rather than retrying it', async () => {
    // A revert here is almost always AlreadyFunded — the pot exists and a retry
    // can only ever revert again. Burning gas on that buries the transient
    // failures that DO deserve a retry.
    escrow.setTransportForTests(async () => HASH, async () => false);

    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    await escrow.drain();
    await escrow.settle();

    const [row] = rows();
    expect(row!.status).toBe('dead');
    expect(row!.attempts).toBe(1);
  });

  it('retries when the receipt never arrives', async () => {
    // Dropped or timed out, not reverted. The transaction may yet land, which is
    // why the outbox and the contract both enforce one pot per hunt.
    escrow.setTransportForTests(async () => HASH, async () => {
      throw new Error('timeout');
    });

    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    await escrow.drain();
    await escrow.settle();

    const [row] = rows();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
  });

  it('keeps a dead row out of later drains', async () => {
    escrow.setTransportForTests(async () => HASH, async () => false);
    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    await escrow.drain();
    await escrow.settle();

    const send = vi.fn(async () => HASH);
    escrow.setTransportForTests(send, async () => true);
    getDb().prepare('UPDATE escrow_queue SET next_at = 0').run();
    await escrow.drain();

    expect(send).not.toHaveBeenCalled();
  });
});

describe('amounts survive the round trip', () => {
  it('preserves an 18-decimal value exactly', async () => {
    const captured: bigint[] = [];
    escrow.setTransportForTests(async job => {
      captured.push(job.amount);
      return HASH;
    }, async () => true);

    // $5.00 of an 18dp stablecoin. Through a JS number this loses precision.
    escrow.enqueue(HUNT, 5_000_000_000_000_000_000n, 1_800_000_000);
    await escrow.drain();
    await escrow.settle();

    expect(captured[0]).toBe(5_000_000_000_000_000_000n);
  });
});

describe('hunt creation queues a pot', () => {
  it('enqueues one row per seeded hunt', () => {
    // freshWorld() seeds zones and replenishes them, which creates hunts — each
    // should have queued its own pot inside the same transaction.
    clearQueue();
    freshWorld();
    const queued = rows();
    expect(queued.length).toBeGreaterThan(0);
    // One per hunt, no duplicates.
    expect(new Set(queued.map(r => r.hunt_id)).size).toBe(queued.length);
    for (const r of queued) {
      expect(BigInt(r.amount)).toBeGreaterThan(0n);
      expect(r.status).toBe('pending');
    }
  });

  /**
   * The units, pinned end to end.
   *
   * This is the seam's one blind spot: every test above hands the queue a
   * number it made up, so a caller feeding the wrong scale is invisible here
   * while being catastrophic on chain. A millisecond epoch read as seconds
   * lands in the year 55000 — `fundHunt` succeeds, `claim` succeeds, and
   * `refund` reverts `NotExpired` forever, quietly disabling the escape hatch
   * that is supposed to survive a lost key or a vanished operator.
   */
  it('hands the chain a seconds timestamp, from a hunt measured in milliseconds', async () => {
    clearQueue();
    freshWorld();

    const jobs: escrow.FundingJob[] = [];
    escrow.setTransportForTests(
      async job => {
        jobs.push(job);
        return HASH;
      },
      async () => true,
    );
    escrow.unstopForTests();
    await escrow.drain();
    await escrow.settle();

    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      // What the real caller passes: a hunt's own expiry, in milliseconds.
      // Asserting the scale here is the half the transport seam cannot see —
      // every other test in this file invents the number it enqueues.
      expect(job.expiresAt).toBeGreaterThan(1e12);

      // And what the chain is given: seconds, ahead of now, in this century.
      const onChain = escrow.toChainSeconds(job.expiresAt);
      expect(onChain).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
      expect(onChain).toBeLessThan(4_102_444_800n); // 2100-01-01
    }
  });
});


describe('hunt id encoding', () => {
  /**
   * This is the bug that made every fundHunt fail on mainnet.
   *
   * The queue stores the readable id ("ridge-1-3x4-aaa"), which is right — it is
   * what joins against the hunts table. The chain wants bytes32. The worker used
   * to pass the string through with `as Hex`: a cast the compiler accepts and
   * the ABI encoder rejects, so nothing was ever funded and no test noticed,
   * because the test asserted the raw string too.
   */
  it('sends bytes32 to the chain, not the readable id', async () => {
    const send = vi.fn<escrow.SendFn>(async () => HASH);
    escrow.setTransportForTests(send, async () => true);

    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    await escrow.drain();

    const sentId = send.mock.calls[0]![0].huntId;
    expect(sentId).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(sentId).not.toBe(HUNT);
  });

  /**
   * The pot is keyed by whatever `fundHunt` was given, and the winner claims
   * with what the attestation signed. If these two encodings ever diverge the
   * money is escrowed against an id nobody can name — funded, and unclaimable.
   */
  it('agrees with the encoding the claim path signs', () => {
    expect(toBytes32Id(HUNT)).toBe(attestor.toBytes32Id(HUNT));
    // Long ids hash rather than pad; both sides must agree there too.
    const long = 'z'.repeat(64);
    expect(toBytes32Id(long)).toBe(attestor.toBytes32Id(long));
  });
});

describe('refunding only what was actually escrowed', () => {
  /**
   * Measured on mainnet: fourteen hunts queued refunds, none of them had ever
   * been funded (the treasury was empty), and every attempt reverted `NotFunded`
   * while logging `pot stranded` at ERROR — about money that did not exist.
   *
   * The gas is the smaller cost. An alarm that fires on the ordinary case makes
   * the real one unfindable.
   */
  it('does not queue a refund for a pot that never landed', () => {
    escrow.enqueueRefund(HUNT, 1_800_000_000);
    expect(rows().filter(r => r.kind === 'refund')).toHaveLength(0);
  });

  it('does not queue one when funding was attempted but died', () => {
    // A dead funding row is one that never landed — an empty treasury, most
    // often. Exactly the mainnet case: the pot was intended, never escrowed.
    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    getDb().prepare("UPDATE escrow_queue SET status = 'dead' WHERE kind = 'fund'").run();

    escrow.enqueueRefund(HUNT, 1_800_000_000);
    expect(rows().filter(r => r.kind === 'refund')).toHaveLength(0);
  });

  it('DOES queue one once funding confirmed — money is really there', async () => {
    const send = vi.fn<escrow.SendFn>(async () => HASH);
    escrow.setTransportForTests(send, async () => true);

    escrow.enqueue(HUNT, 5n, 1_800_000_000);
    await escrow.drain();
    await escrow.settle();
    expect(rows().find(r => r.kind === 'fund')!.status).toBe('confirmed');

    escrow.enqueueRefund(HUNT, 1_800_000_000);
    expect(rows().filter(r => r.kind === 'refund')).toHaveLength(1);
  });
});
