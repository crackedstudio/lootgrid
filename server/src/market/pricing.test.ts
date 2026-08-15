import { describe, expect, it } from 'vitest';
import { prizeCentsFor } from '../prizes';
import { TIER_RELIABILITY_BPS, type HintPayload } from '../hints/types';
import { MIN_TRADE_CENTS } from './fees';
import { DECAY_PER_SALE, informationValue, isRationalToBuy, suggestAsk } from './pricing';

/**
 * Hint pricing.
 *
 * The number this file is really defending is the one from architecture §1: a
 * rational agent refuses a negative-EV purchase, so a suggested price above the
 * expected prize share does not slow the market down, it empties it.
 */

const broad = { payload: { kind: 'region', quadrant: 'NW' } as HintPayload, reliabilityBps: TIER_RELIABILITY_BPS[1] };
const sharp = {
  payload: { kind: 'distance', r: 8, c: 5, within: 1 } as HintPayload,
  reliabilityBps: TIER_RELIABILITY_BPS[3],
};

describe('information value', () => {
  it('is the product of how much is ruled out and how often it is true', () => {
    // Neither half alone prices anything: a sharp hint you cannot trust and a
    // trustworthy hint that rules nothing out are worth about the same.
    expect(informationValue(broad)).toBeCloseTo(0.75 * 0.9, 5);
    expect(informationValue(sharp)).toBeGreaterThan(0.4);
  });

  it('puts the tiers closer together than their labels suggest', () => {
    // Tiers are a trade, not a ladder — precision is bought with reliability.
    const gap = Math.abs(informationValue(sharp) - informationValue(broad));
    expect(gap).toBeLessThan(0.35);
  });

  it('is zero for a hint that rules nothing out', () => {
    const useless = { payload: { kind: 'rowBand', from: 0, to: 17 } as HintPayload, reliabilityBps: 9_000 };
    expect(informationValue(useless)).toBe(0);
  });
});

describe('suggested ask', () => {
  it('stays a fraction of the prize', () => {
    // A hint governs discovery; the challenge still governs victory. Paying most
    // of the pot for directions is never right.
    const prize = prizeCentsFor('hard');
    expect(suggestAsk(broad, prize).cents).toBeLessThan(prize / 2);
  });

  it('prices a stronger hint above a weaker one', () => {
    const prize = prizeCentsFor('hard');
    const weak = { payload: { kind: 'parity', parity: 'even' } as HintPayload, reliabilityBps: 5_000 };
    expect(suggestAsk(broad, prize).cents).toBeGreaterThan(suggestAsk(weak, prize).cents);
  });

  it('falls with every copy already sold', () => {
    // Information copies. A market where the tenth copy costs what the first did
    // is one where nobody buys the first.
    const prize = prizeCentsFor('hard');
    const first = suggestAsk(broad, prize, 0).cents;
    const fourth = suggestAsk(broad, prize, 3).cents;
    expect(fourth).toBeLessThan(first);
    expect(DECAY_PER_SALE).toBeGreaterThan(0);
  });

  it('never drops below the minimum tradeable amount', () => {
    expect(suggestAsk(broad, prizeCentsFor('hard'), 500).cents).toBe(MIN_TRADE_CENTS);
  });

  it('reports that the easy band has no market at all', () => {
    // A 1c prize cannot cover a 1c hint at any share, so the honest answer is
    // that this hunt's hints are unsellable — not a price at the floor.
    const suggestion = suggestAsk(broad, prizeCentsFor('easy'));
    expect(suggestion.rational).toBe(false);
    expect(suggestion.ceilingCents).toBeLessThan(MIN_TRADE_CENTS);
  });

  it('reports the mid band as tradeable', () => {
    expect(suggestAsk(broad, prizeCentsFor('med')).rational).toBe(true);
  });
});

describe('whether buying is rational at all', () => {
  it('refuses a price above one entrant’s expected share', () => {
    // 50c prize, eight racers — a share worth 6.25c.
    expect(isRationalToBuy(6, 50, 8)).toBe(true);
    expect(isRationalToBuy(7, 50, 8)).toBe(false);
  });

  it('gets worse as a hunt gets more popular', () => {
    // The uncomfortable half of the same arithmetic that governs entry fees: a
    // price that is generous at eight entrants is extortionate at forty.
    expect(isRationalToBuy(5, 50, 8)).toBe(true);
    expect(isRationalToBuy(5, 50, 40)).toBe(false);
  });

  it('refuses everything when there is no prize', () => {
    expect(isRationalToBuy(1, 0, 8)).toBe(false);
  });
});
