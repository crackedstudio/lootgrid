import { MILLS_PER_CENT } from '../market/fees';
import { MAX_PRIZE_CENTS, PRIZE_CENTS } from '../prizes';
import type { Difficulty } from '../types';

/**
 * What the game can afford to pay.
 *
 * ─────────────────────────── the ceiling, from §1 ───────────────────────────
 *
 * Architecture §1 settles the economics and this file is the arithmetic:
 *
 *     total prizes  ≤  deposits + sponsorship − inference − margin
 *
 * and, stated just as plainly there: **prizes scale with player count, never
 * with trade volume.** Funding prizes from trading fees is the closed-loop
 * fallacy — in an economy whose only inflow is prizes, fee revenue is bounded
 * above by prizes minus inference, so fees can never fund the prizes they are
 * levied against.
 *
 * The rake is therefore *not* treated as prize funding here. It is counted, but
 * as a contribution to margin rather than to the pot, and the difference is the
 * whole reason phase 10 exists: a treasury that sized prizes off trading volume
 * would look healthy exactly while it was eating itself.
 *
 * ─────────────────────────── the static table is a ceiling ──────────────────
 *
 * `PRIZE_CENTS.hard` is already `MAX_PRIZE_CENTS`, which is the escrow's own
 * per-hunt cap — so the scale here can never exceed 1 and the band can only
 * ever sit *at or below* the phase 3 table. That is the right shape: the
 * contract's cap is the ceiling, the static table is what the game pays when it
 * can afford to, and inflow decides how far below that it currently is.
 *
 * A treasury that could raise prizes above the cap would be proposing hunts the
 * escrow would refuse to fund.
 *
 * ─────────────────────────── it only ever shrinks fast ──────────────────────
 *
 * Prizes move down quickly and up slowly. A tier that jumps because one good
 * day of deposits landed will have to come back down, and a prize that falls
 * after a player has decided to chase it is the worst thing this system can do
 * to somebody. Asymmetric on purpose.
 */

/** Fraction of net inflow that may become prizes. The rest is margin. */
export const PRIZE_SHARE = 0.6;

/** How much of a gap the band may close upward in one step. */
export const RAISE_STEP = 0.1;

/** ...and downward. Faster, because paying what you cannot afford is worse. */
export const LOWER_STEP = 0.5;

/**
 * The floor. Below this a hunt is not worth entering at any difficulty, so the
 * honest move is to stop creating hunts rather than to advertise a prize
 * nobody should chase.
 */
export const MIN_PRIZE_CENTS = 1;

export interface Inflow {
  /** Entry fees actually settled, in cents. */
  entryFeeCents: number;
  /** Rake collected, in cents. Counted toward margin, never toward prizes. */
  rakeCents: number;
  /** Deposits and sponsorship, in cents. The only real prize funding. */
  depositCents: number;
  /** Inference billed to agents, in mills. Cost of goods sold. */
  inferenceMills: number;
  /** Hunts created over the same window. */
  hunts: number;
}

export interface Band {
  /** The affordable prize for each difficulty, in cents. */
  prizes: Record<Difficulty, number>;
  /** Net inflow after inference, in cents. */
  netCents: number;
  /** What one hunt may cost on average, in cents. */
  perHuntCents: number;
  /** True when the game cannot afford to run rewarded hunts at all. */
  starved: boolean;
}

/**
 * The prize band a measured window can support.
 *
 * Deliberately takes its inputs rather than reading them: the same function
 * answers "what can we afford now" and "what would we have afforded last week",
 * and a version that reached into the database could only answer the first.
 */
export function bandFor(inflow: Inflow): Band {
  const inferenceCents = inflow.inferenceMills / MILLS_PER_CENT;

  // Deposits fund prizes. Entry fees are a participation filter and are
  // net-negative by construction on agent zones (§1), so they are counted at
  // face value and no more. The rake is margin, not funding — see the header.
  const netCents = Math.max(0, inflow.depositCents + inflow.entryFeeCents - inferenceCents);
  const budget = netCents * PRIZE_SHARE;
  const perHuntCents = inflow.hunts > 0 ? budget / inflow.hunts : 0;

  // The static table is the *shape* of the band; inflow sets its scale. Keeping
  // the ratios fixed means a hard hunt is always worth chasing relative to a
  // med one, however lean the week.
  const reference = PRIZE_CENTS.med;
  const wanted = reference > 0 ? perHuntCents / reference : 0;

  // Clamp the SCALE, not each tier. Clamping tiers independently collapses the
  // band at high inflow — med and hard both hit the ceiling and a hard hunt
  // stops being worth more than a med one, which quietly breaks the difficulty
  // draw and the hint pricing that both read the ratio between them.
  const ceiling = MAX_PRIZE_CENTS / PRIZE_CENTS.hard;
  const scale = Math.min(wanted, ceiling);

  const prizes = {
    easy: clamp(PRIZE_CENTS.easy * scale),
    med: clamp(PRIZE_CENTS.med * scale),
    hard: clamp(PRIZE_CENTS.hard * scale),
  };

  return {
    prizes,
    netCents: Math.round(netCents),
    perHuntCents: Math.round(perHuntCents),
    // A grid advertising prizes it cannot cover is worse than a quiet one.
    starved: perHuntCents < MIN_PRIZE_CENTS,
  };
}

function clamp(cents: number): number {
  return Math.max(MIN_PRIZE_CENTS, Math.min(MAX_PRIZE_CENTS, Math.round(cents)));
}

/**
 * Move the live band toward an affordable one, one step at a time.
 *
 * The asymmetry is the point. Raising slowly means a lucky week does not commit
 * the treasury to a level it cannot hold; lowering quickly means a bad one does
 * not keep paying out at yesterday's rate. And a player who sees $5 hunts today
 * should not find $0.50 hunts tomorrow because a single day was quiet.
 */
export function stepToward(
  current: Record<Difficulty, number>,
  target: Record<Difficulty, number>,
): Record<Difficulty, number> {
  const step = (from: number, to: number): number => {
    if (to === from) return from;
    const rate = to > from ? RAISE_STEP : LOWER_STEP;
    const moved = from + (to - from) * rate;
    // Always move at least a cent, or a band can converge asymptotically and
    // never actually arrive.
    const atLeastOne = to > from ? Math.ceil(moved) : Math.floor(moved);
    return Math.max(MIN_PRIZE_CENTS, Math.min(MAX_PRIZE_CENTS, atLeastOne));
  };

  return {
    easy: step(current.easy, target.easy),
    med: step(current.med, target.med),
    hard: step(current.hard, target.hard),
  };
}

/**
 * Whether a band is affordable against what is actually held.
 *
 * The last check before hunts are created with these numbers on them. A prize
 * the treasury cannot cover is not a prize, it is a promise — and the escrow
 * would refuse the funding anyway, leaving a hunt on the grid with nothing
 * behind it.
 */
export function affordable(
  band: Record<Difficulty, number>,
  liveHunts: number,
  treasuryCents: number,
): boolean {
  // Worst case: every live hunt is the dearest tier and every one is won.
  return band.hard * liveHunts <= treasuryCents;
}
