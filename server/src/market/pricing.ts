import { sharpness, type Hint } from '../hints/types';
import { MIN_TRADE_CENTS } from './fees';

/**
 * What a hint is worth, and when buying one stops being rational.
 *
 * ─────────────────────────── the two halves of value ─────────────────────────
 *
 * A hint is worth the search it saves times the chance it is telling the truth,
 * and those two move in opposite directions by design: a vague hint is usually
 * true, a sharp one is close to a coin flip. So neither number alone prices
 * anything.
 *
 *     value ≈ sharpness × reliability
 *
 * `sharpness` is the fraction of the grid the payload rules out — already
 * defined in hints/types.ts, and the reason it was defined there. A tier-1
 * quadrant hint rules out three quarters of the map and is right 90% of the
 * time; a tier-3 ring rules out 95% and is right half the time. They land closer
 * together than the tier labels suggest, which is the intended shape: tiers are
 * a trade, not a ladder.
 *
 * ─────────────────────────── the ceiling that matters ───────────────────────
 *
 * Nobody rational pays more for directions than the prize is worth, and on agent
 * zones "rational" is literal — an LLM optimising a balance simply does not buy.
 * The same arithmetic as entry fees (payments/fees.ts §the constraint) applies,
 * with the hint price joining the fee on the cost side:
 *
 *     EV = P/N − F − hint price      must be > 0
 *
 * At the bottom of the prize band this leaves nothing: a 1¢ prize shared eight
 * ways is worth an eighth of a cent, so no hint price above zero is rational and
 * {@link MIN_TRADE_CENTS} is already too much. Easy hunts therefore have no hint
 * market, by arithmetic rather than by rule — and {@link suggestAsk} says so
 * rather than quietly suggesting a price nobody should pay.
 *
 * ─────────────────────────── price decay is not a bug ───────────────────────
 *
 * Information copies. Every buyer after the first is buying something more
 * people already know, and the suggestion falls accordingly. A market where the
 * tenth copy costs what the first did is one where nobody buys the first.
 */

/**
 * Share of the prize a perfect hint could justify.
 *
 * Well under half. A hint governs *discovery*, not victory — the challenge still
 * has to be won against everyone else who found the hunt — so even certain
 * directions are worth a fraction of the pot, not most of it.
 */
export const MAX_VALUE_SHARE = 0.25;

/** How fast a hint's suggested price falls with each copy already sold. */
export const DECAY_PER_SALE = 0.35;

/**
 * Information content of a hint, 0–1.
 *
 * Deliberately multiplicative: a sharp hint you cannot trust and a trustworthy
 * hint that rules out nothing are both worth about the same very little.
 */
export function informationValue(hint: Pick<Hint, 'payload' | 'reliabilityBps'>): number {
  return sharpness(hint.payload) * (hint.reliabilityBps / 10_000);
}

export interface AskSuggestion {
  cents: number;
  /**
   * False when no price a seller would accept is one a buyer should pay. The UI
   * shows the hint as unsellable rather than pricing it at the floor and letting
   * someone discover the problem with their money.
   */
  rational: boolean;
  /** The ceiling the suggestion was clamped against, for display. */
  ceilingCents: number;
  informationValue: number;
}

/**
 * A starting price for a listing. Advice, never enforcement — a seller may ask
 * whatever they like, and price discovery is the point of having a market.
 */
export function suggestAsk(
  hint: Pick<Hint, 'payload' | 'reliabilityBps'>,
  prizeCents: number,
  alreadySold = 0,
): AskSuggestion {
  const value = informationValue(hint);
  const ceiling = Math.floor(prizeCents * MAX_VALUE_SHARE);
  const decayed = (prizeCents * MAX_VALUE_SHARE * value) / (1 + DECAY_PER_SALE * alreadySold);

  // Rounded up: at these sizes rounding down puts almost everything at zero.
  const cents = Math.max(MIN_TRADE_CENTS, Math.min(ceiling, Math.ceil(decayed)));

  return {
    cents,
    // If the whole prize share cannot cover the smallest tradeable amount, the
    // market for this hunt does not exist at any price.
    rational: ceiling >= MIN_TRADE_CENTS,
    ceilingCents: ceiling,
    informationValue: value,
  };
}

/**
 * Whether paying this much for a hint leaves a positive expected value.
 *
 * Optimistic on purpose — it ignores the entry fee, inference, and the fact that
 * finding a hunt is not the same as winning it. A price this rejects is one no
 * agent would pay under any circumstances.
 */
export function isRationalToBuy(priceCents: number, prizeCents: number, entrants: number): boolean {
  if (priceCents <= 0) return true;
  if (prizeCents <= 0 || entrants <= 0) return false;
  return priceCents < prizeCents / entrants;
}
