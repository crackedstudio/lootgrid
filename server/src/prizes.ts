import { hashInt } from './hash';
import type { Difficulty } from './types';

/**
 * What a hunt is worth.
 *
 * Replaces the hardcoded `PRIZE_LABELS = ['$3.00','$5.50','$12.00','$24.00']`,
 * which was display-only and, at those levels, unaffordable. The band here is
 * $0.01–$5.00 by difficulty, roughly two orders of magnitude lower — see
 * docs/AGENTIC_ARCHITECTURE.md §10. Prizes are meant to rise from real deposit
 * inflow, not to be picked optimistically and defended afterwards.
 *
 * ─────────────────────────── units ───────────────────────────
 *
 * Amounts are held in **cents** here and converted to token units at the edge.
 * Money is never a float: `0.1 + 0.2 !== 0.3`, and a rounding error that credits
 * a player a fraction more than escrow holds is a solvency bug, not a display
 * bug. The contract's per-hunt cap is the backstop, but the arithmetic should
 * not be leaning on it.
 *
 * Celo stablecoins differ in decimals — cUSD and USDm are 18dp, USDC and USDT
 * are 6dp — so `toTokenUnits` takes the decimals rather than assuming.
 */

/** Prize in cents, per difficulty. */
export const PRIZE_CENTS: Record<Difficulty, number> = {
  easy: 1, // $0.01
  med: 50, // $0.50
  hard: 500, // $5.00
};

/** Hard ceiling, mirrored by the contract's `perHuntCap`. */
export const MAX_PRIZE_CENTS = 500;

export function prizeCentsFor(difficulty: Difficulty): number {
  return PRIZE_CENTS[difficulty] ?? PRIZE_CENTS.easy;
}

/**
 * How often each tier is drawn, out of 100.
 *
 * ─────────────────────────── why not uniform ───────────────────────────
 *
 * The prize band spans two orders of magnitude — a hard hunt is 500× an easy
 * one — so the distribution *is* the treasury's burn rate. A third of hunts at
 * $5 would be a different business, not a harder game.
 *
 * At these weights a hunt costs 56.6c in expectation:
 *
 *     0.60 × 1c  +  0.32 × 50c  +  0.08 × 500c  =  56.6c
 *
 * Sixteen live hunts (4 zones × {@link HUNTS_PER_ZONE}) on a 24h TTL is roughly
 * $9/day of funding, against $8 for the flat `med` this replaces. Worst case —
 * every hunt hard, every one claimed — is $80/day, which still sits under the
 * escrow's example per-day claim cap of $100. A cap that binds turns a
 * legitimate win into a revert, so leaving that headroom is the point.
 *
 * ─────────────────────────── the tension ───────────────────────────
 *
 * `easy` is the knob with two opposite pulls, and it is worth knowing which way
 * you are turning it. Raising it lowers burn and keeps a no-risk hunt always on
 * the grid — but easy hunts have a 1c prize, and no hint price above zero is
 * rational against that (market/pricing.ts), so their hints are unsellable and
 * a high `easy` share thins the hint market. Lowering it does the reverse.
 * Phase 10 replaces this table with sizing driven by real deposit inflow.
 */
export const DIFFICULTY_WEIGHTS: ReadonlyArray<readonly [Difficulty, number]> = [
  ['easy', 60],
  ['med', 32],
  ['hard', 8],
];

const WEIGHT_TOTAL = DIFFICULTY_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);

/**
 * The difficulty of a block, drawn from its salt.
 *
 * A property of the BLOCK, not of the player — same rule as `gameTypeForBlock`,
 * and for the same reasons. Everyone racing a hunt faces the same challenge for
 * the same prize, it is fixed before anyone enters, and it is verifiable once
 * the salt is revealed. A difficulty that could vary per player would mean the
 * house choosing who gets the cheap hunts.
 */
export function difficultyForBlock(salt: string, huntId: string): Difficulty {
  let roll = hashInt(salt, huntId, 'difficulty') % WEIGHT_TOTAL;
  for (const [difficulty, weight] of DIFFICULTY_WEIGHTS) {
    if (roll < weight) return difficulty;
    roll -= weight;
  }
  // Unreachable while the weights sum to WEIGHT_TOTAL. Cheapest tier, not the
  // dearest, so a future arithmetic slip costs nothing.
  return 'easy';
}

/** Display string. The only place a prize is ever formatted for a human. */
export function formatPrize(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function prizeLabelFor(difficulty: Difficulty): string {
  return formatPrize(prizeCentsFor(difficulty));
}

/**
 * Cents → token base units, as a bigint.
 *
 * `10n ** BigInt(decimals - 2)` is exact for any decimals ≥ 2, which every Celo
 * stablecoin satisfies. Doing this in floating point would be wrong for 18dp
 * tokens long before it looked wrong.
 */
export function toTokenUnits(cents: number, decimals: number): bigint {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`prize must be a non-negative whole number of cents, got ${cents}`);
  }
  if (decimals < 2) {
    throw new Error(`unsupported token decimals: ${decimals}`);
  }
  return BigInt(cents) * 10n ** BigInt(decimals - 2);
}
