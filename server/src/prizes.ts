import { hashInt } from './hash';
import type { Difficulty, ZoneKind } from './types';

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

/**
 * The floor a prize has to clear to have a hint market at all.
 *
 * ─────────────────────────── why 1c had to go ───────────────────────────
 *
 * `market/pricing.ts` caps what a hint may be worth at {@link MAX_VALUE_SHARE}
 * — a quarter of the prize — because a hint governs *discovery*, not victory.
 * On a 1c hunt that ceiling is a quarter of a cent, which is below
 * `MIN_TRADE_CENTS`, so `suggestAsk` refused to price those hints at all. Sixty
 * percent of every hunt drawn was in that tier.
 *
 * That is the whole reason the market looked dead. Three phases built listing,
 * bonding, slashing, reputation and negotiation on top of an inventory that was
 * mostly unsellable *by arithmetic* — not because nobody wanted it. Raising the
 * floor is the one-line change that turns the market on.
 *
 * 60c is the lowest prize whose 25% ceiling (15c) leaves room for a real
 * spread between a broad hint and a sharp one.
 */
export const MIN_VIABLE_PRIZE_CENTS = 60;

/**
 * Prize in cents, per difficulty.
 *
 * The 1c tier is deleted — not by removing `easy`, which is also the *game's*
 * difficulty and still wants to exist for players who are new, but by lifting
 * the cheapest prize to {@link MIN_VIABLE_PRIZE_CENTS}. An easy hunt is still
 * an easy game; it is no longer a hunt whose hints cannot legally be sold.
 */
export const PRIZE_CENTS: Record<Difficulty, number> = {
  easy: MIN_VIABLE_PRIZE_CENTS, // $0.60
  med: 120, // $1.20
  hard: 500, // $5.00
};

/** Hard ceiling, mirrored by the contract's `perHuntCap`. */
export const MAX_PRIZE_CENTS = 500;

/**
 * The band in force, or the static table.
 *
 * Set by the treasury agent once phase 10 is running. A function rather than an
 * import so that `prizes.ts` — which everything depends on — does not depend on
 * the treasury in turn, and so that a treasury that is switched off leaves this
 * module behaving exactly as it did in phase 3.
 */
let liveBand: (() => Record<Difficulty, number>) | null = null;

export function setBandSource(source: (() => Record<Difficulty, number>) | null): void {
  liveBand = source;
}

export function prizeCentsFor(difficulty: Difficulty): number {
  const band = liveBand?.() ?? PRIZE_CENTS;
  return band[difficulty] ?? band.easy ?? PRIZE_CENTS.easy;
}

/**
 * How often each tier is drawn, out of 100.
 *
 * ─────────────────────────── why not uniform ───────────────────────────
 *
 * The prize band spans an order of magnitude, so the distribution *is* the
 * treasury's burn rate. A third of hunts at $5 would be a different business,
 * not a harder game.
 *
 * At these weights a hunt costs 114.4c in expectation:
 *
 *     0.60 × 60c  +  0.32 × 120c  +  0.08 × 500c  =  114.4c
 *
 * Burn is now governed by how many hunts carry money at all rather than by how
 * many exist — see `CASH_PER_ZONE` in config.ts, which carries the full
 * arithmetic. Four cash hunts a day across the world lands near $156/month,
 * inside the $100–300 self-funded floor with room left for a concentrated
 * weekly prize.
 *
 * ─────────────────────────── the tension, resolved ──────────────────────────
 *
 * `easy` used to be a knob with two opposite pulls: raising it lowered burn but
 * thinned the hint market, because an easy hunt paid 1c and no hint price above
 * zero was rational against that. Lifting the floor to
 * {@link MIN_VIABLE_PRIZE_CENTS} removes the conflict — every tier now clears
 * the market's floor, so the weights are purely a burn-rate decision and can be
 * tuned as one. Phase 10 replaces this table with sizing driven by real deposit
 * inflow.
 */
export const DIFFICULTY_WEIGHTS: ReadonlyArray<readonly [Difficulty, number]> = [
  ['easy', 60],
  ['med', 32],
  ['hard', 8],
];

/**
 * The same table for agent zones, with `easy` removed.
 *
 * This was arithmetic when an easy hunt paid 1c against ~0.3c of agent thinking
 * — an agent that entered was paying to lose, and a house offering hunts no
 * rational player enters is just leaving dead squares on the grid. At the
 * raised floor a 60c hunt clears that bar comfortably, so `easy` is now
 * excluded for a softer reason: an agent zone exists to pose problems worth
 * reasoning about, and the easy table is four probes of slack.
 *
 * Weighted toward `med` rather than mirroring the human split: hard hunts are
 * $5, and one agent zone drawing them a third of the time would cost more per
 * day than the other four zones combined.
 */
export const AGENT_DIFFICULTY_WEIGHTS: ReadonlyArray<readonly [Difficulty, number]> = [
  ['med', 88],
  ['hard', 12],
];

const weightsFor = (kind: ZoneKind) =>
  kind === 'agent' ? AGENT_DIFFICULTY_WEIGHTS : DIFFICULTY_WEIGHTS;

/**
 * The difficulty of a block, drawn from its salt.
 *
 * A property of the BLOCK, not of the player — same rule as `gameTypeForBlock`,
 * and for the same reasons. Everyone racing a hunt faces the same challenge for
 * the same prize, it is fixed before anyone enters, and it is verifiable once
 * the salt is revealed. A difficulty that could vary per player would mean the
 * house choosing who gets the cheap hunts.
 */
export function difficultyForBlock(
  salt: string,
  huntId: string,
  kind: ZoneKind = 'human',
): Difficulty {
  const weights = weightsFor(kind);
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);

  let roll = hashInt(salt, huntId, 'difficulty') % total;
  for (const [difficulty, weight] of weights) {
    if (roll < weight) return difficulty;
    roll -= weight;
  }
  // Unreachable while the weights sum to `total`. Cheapest tier in the table,
  // not the dearest, so a future arithmetic slip costs nothing.
  return weights[0]![0];
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
