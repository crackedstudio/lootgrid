import { describe, expect, it } from 'vitest';
import {
  MILLS_PER_CENT,
  MIN_TRADE_CENTS,
  RAKE_BPS,
  SETTLE_THRESHOLD_MILLS,
  isTradeable,
  rakeMillsFor,
  realisedRakeBps,
  sellerMillsFor,
  splitAccrual,
} from './fees';

/**
 * The rake.
 *
 * The thing being defended against here is not fraud, it is rounding. At the
 * prize scale this game runs on, a percentage fee on a one-cent trade is a
 * fraction of a cent — and whichever way that gets rounded, someone is robbed.
 */

describe('rake arithmetic', () => {
  it('takes the configured rate on a large trade', () => {
    // 100c at 2.5% = 2.5c = 2500 mills.
    expect(rakeMillsFor(100)).toBe(2_500);
    expect(sellerMillsFor(100)).toBe(97_500);
  });

  it('keeps a sub-cent rake instead of rounding it away', () => {
    // The dust case. 2.5% of 1c is 0.025c — rounding up would be a 100% tax,
    // rounding down collects nothing forever. 25 mills is neither.
    expect(rakeMillsFor(1)).toBe(25);
    expect(sellerMillsFor(1)).toBe(975);
  });

  it('never takes more than the trade is worth', () => {
    for (let price = 0; price <= 500; price++) {
      const rake = rakeMillsFor(price);
      expect(rake).toBeGreaterThanOrEqual(0);
      expect(rake + sellerMillsFor(price)).toBe(price * MILLS_PER_CENT);
    }
  });

  it('rejects a nonsensical price rather than guessing', () => {
    expect(() => rakeMillsFor(1.5)).toThrow(/whole number/);
    expect(() => rakeMillsFor(-1)).toThrow(/non-negative/);
  });
});

describe('accrual', () => {
  it('holds a balance below a cent rather than moving it', () => {
    const { settleCents, remainderMills } = splitAccrual(999);
    expect(settleCents).toBe(0);
    expect(remainderMills).toBe(999);
  });

  it('settles whole cents and carries the fraction', () => {
    const { settleCents, remainderMills } = splitAccrual(2_750);
    expect(settleCents).toBe(2);
    expect(remainderMills).toBe(750);
  });

  it('loses nothing across many small trades', () => {
    // 40 one-cent trades at 25 mills each = 1000 mills = exactly 1c. If the
    // fraction were discarded per trade this would collect zero.
    let balance = 0;
    for (let i = 0; i < 40; i++) balance += rakeMillsFor(1);
    const { settleCents, remainderMills } = splitAccrual(balance);
    expect(settleCents).toBe(1);
    expect(remainderMills).toBe(0);
  });

  it('conserves value over a long run', () => {
    let balance = 0;
    let totalPrice = 0;
    for (let i = 1; i <= 1_000; i++) {
      const price = (i % 7) + 1;
      totalPrice += price;
      balance += rakeMillsFor(price);
    }
    const { settleCents, remainderMills } = splitAccrual(balance);
    // Everything accrued is either settled or still carried — never vanished.
    expect(settleCents * MILLS_PER_CENT + remainderMills).toBe(balance);
    // And the realised rate lands on the configured one.
    expect(realisedRakeBps(totalPrice, settleCents)).toBeGreaterThan(RAKE_BPS - 30);
    expect(realisedRakeBps(totalPrice, settleCents)).toBeLessThanOrEqual(RAKE_BPS);
  });

  it('reports a dust-only market as collecting nothing', () => {
    // Worth surfacing rather than hiding: a realised rate stuck near zero means
    // every trade is below the settle threshold.
    expect(realisedRakeBps(100, 0)).toBe(0);
    expect(splitAccrual(SETTLE_THRESHOLD_MILLS - 1).settleCents).toBe(0);
  });
});

describe('minimum trade size', () => {
  it('refuses trades below the floor', () => {
    expect(isTradeable(MIN_TRADE_CENTS)).toBe(true);
    expect(isTradeable(MIN_TRADE_CENTS - 1)).toBe(false);
    expect(isTradeable(0)).toBe(false);
  });

  it('refuses fractional prices', () => {
    expect(isTradeable(1.5)).toBe(false);
  });
});
