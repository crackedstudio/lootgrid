import { getDb } from '../db';
import { MAX_PRIZE_CENTS } from '../prizes';
import type { Difficulty } from '../types';

/**
 * The money that must never be allocated.
 *
 * ─────────────────────────── what the buffer is for ─────────────────────────
 *
 * One sentence: **payouts never wait on an allocation decision.**
 *
 * A treasury agent that moved the float into something clever while a winner
 * was waiting to be paid would have failed at the only job the treasury has.
 * The contract enforces this with a `reserveFloor` the proposer cannot reach at
 * any price; this module computes what that floor should be.
 *
 * ─────────────────────────── obligations, not guesses ───────────────────────
 *
 * The floor is not a percentage or a feeling. It is the sum of what the house
 * has actually committed to:
 *
 *   * every live hunt's prize, because each one is a promise already made to
 *     whoever wins it
 *   * every pot queued for funding but not yet on chain — the outbox is a
 *     commitment the moment the hunt is created
 *
 * Plus a margin for the hunts that will be created before the next allocation
 * runs, because a floor that is exactly right today is too low tomorrow.
 *
 * ─────────────────────────── it is deliberately pessimistic ─────────────────
 *
 * Live hunts are counted at the *dearest* tier they could be, not at their own.
 * Being wrong in this direction costs some idle float; being wrong in the other
 * costs a winner their prize, which is the failure this whole phase exists to
 * make impossible.
 */

/** Hunts assumed to be created before the next allocation. Headroom, not a guess. */
export const LOOKAHEAD_HUNTS = 8;

export interface Obligations {
  /** Prizes owed on hunts that are still playable, in cents. */
  liveHuntCents: number;
  /** Pots created but not yet funded on chain, in cents. */
  queuedCents: number;
  /** Headroom for hunts created before the next allocation, in cents. */
  lookaheadCents: number;
  /** What the contract's reserveFloor should be, in cents. */
  floorCents: number;
}

/**
 * Everything the house has already promised.
 *
 * Reads the same two tables the rest of the system writes: live hunts, and the
 * escrow outbox. There is no separate ledger of obligations, on purpose — one
 * that could drift from the hunts it describes would be worse than none.
 */
export function obligations(band: Record<Difficulty, number>, now = Date.now()): Obligations {
  const db = getDb();

  const live = db
    .prepare("SELECT COUNT(*) AS n FROM hunts WHERE status IN ('live', 'resolving')")
    .get() as { n: number };

  const queued = db
    .prepare("SELECT COUNT(*) AS n FROM escrow_queue WHERE status IN ('pending', 'sent')")
    .get() as { n: number };

  // The dearest tier a live hunt could be. Cheaper to hold idle float than to
  // discover a winner cannot be paid.
  const worstCase = Math.max(band.hard, band.med, band.easy, 1);

  const liveHuntCents = live.n * worstCase;
  const queuedCents = queued.n * worstCase;
  const lookaheadCents = LOOKAHEAD_HUNTS * worstCase;
  void now;

  return {
    liveHuntCents,
    queuedCents,
    lookaheadCents,
    floorCents: liveHuntCents + queuedCents + lookaheadCents,
  };
}

/**
 * Whether the treasury is holding enough to keep its promises.
 *
 * Called before an allocation is proposed, and it is the reason the agent
 * usually proposes nothing: a treasury exactly covering its obligations has no
 * spare float, and that is a healthy state rather than a stalled one.
 */
export function healthy(treasuryCents: number, floorCents: number): boolean {
  return treasuryCents >= floorCents;
}

/**
 * What could be allocated without breaking a promise, in cents.
 *
 * Never negative: a treasury below its floor has nothing to allocate and needs
 * topping up, which is a human decision rather than an agent one.
 */
export function surplus(treasuryCents: number, floorCents: number): number {
  return Math.max(0, treasuryCents - floorCents);
}

/**
 * A sanity bound on the floor itself.
 *
 * A runaway obligation count — a bug that never resolves hunts, say — would
 * otherwise compute a floor larger than the treasury and freeze allocation
 * permanently while looking like prudence. Capped so that failure is visible as
 * "the floor hit its ceiling" rather than as silence.
 */
export const MAX_FLOOR_CENTS = MAX_PRIZE_CENTS * 500;

export function boundedFloor(floorCents: number): number {
  return Math.min(floorCents, MAX_FLOOR_CENTS);
}
