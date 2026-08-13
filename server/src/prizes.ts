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
