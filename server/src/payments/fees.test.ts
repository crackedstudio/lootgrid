import { describe, expect, it } from 'vitest';
import {
  ENTRY_FEE_CENTS,
  EV_ALERT_RATIO,
  evRatio,
  feeCentsFor,
  isRationalToEnter,
  quoteEntry,
  safeEntrantCeiling,
} from './fees';
import { prizeCentsFor } from '../prizes';

/**
 * Entry-fee economics.
 *
 * The property that matters is not "does the fee compute" but "would a rational
 * entrant pay it". On agent zones a fee above the EV line does not reduce
 * participation, it ends it — so these assertions are the difference between a
 * working economy and an empty one.
 */

describe('the EV ratio', () => {
  it('is fee over a single entrant share', () => {
    // $0.50 prize, 8 entrants → 6.25¢ each. A 1¢ fee is 16% of that.
    expect(evRatio(1, 50, 8)).toBeCloseTo(0.16, 2);
  });

  it('gets worse as a hunt gets more popular', () => {
    // The uncomfortable one: the same fee is a bigger bite when more people
    // split the prize, so success degrades the deal for everyone in it.
    expect(evRatio(1, 50, 8)).toBeLessThan(evRatio(1, 50, 20));
    expect(evRatio(1, 50, 20)).toBeLessThan(evRatio(1, 50, 40));
  });

  it('is zero for a free hunt regardless of prize', () => {
    expect(evRatio(0, 50, 8)).toBe(0);
    expect(evRatio(0, 0, 0)).toBe(0);
  });

  it('refuses to call a prizeless paid hunt healthy', () => {
    // A degenerate case must not read as a good deal.
    expect(evRatio(5, 0, 8)).toBe(Number.POSITIVE_INFINITY);
    expect(isRationalToEnter(5, 0, 8)).toBe(false);
  });
});

describe('configured fees are payable', () => {
  it('keeps every difficulty rational at a realistic hunt size', () => {
    for (const d of ['easy', 'med', 'hard'] as const) {
      const fee = ENTRY_FEE_CENTS[d];
      const prize = prizeCentsFor(d);
      expect(isRationalToEnter(fee, prize, 8), `${d} is not worth entering`).toBe(true);
    }
  });

  it('stays under the alert ratio at a realistic hunt size', () => {
    for (const d of ['easy', 'med', 'hard'] as const) {
      expect(evRatio(ENTRY_FEE_CENTS[d], prizeCentsFor(d), 8)).toBeLessThan(EV_ALERT_RATIO);
    }
  });

  it('makes easy hunts free, because no positive fee could ever be rational', () => {
    // A 1¢ prize split eight ways is an eighth of a cent. There is no fee above
    // zero an agent would pay for that, so the config must not invent one.
    expect(ENTRY_FEE_CENTS.easy).toBe(0);
    expect(isRationalToEnter(1, prizeCentsFor('easy'), 8)).toBe(false);
  });
});

describe('the ceiling is real and should be watched', () => {
  it('reports where a fee stops being safe', () => {
    // $0.50 prize, 1¢ fee: fine to 30 entrants, flagged past that.
    expect(safeEntrantCeiling(1, 50)).toBe(30);
    expect(evRatio(1, 50, 30)).toBeLessThanOrEqual(EV_ALERT_RATIO);
    expect(evRatio(1, 50, 31)).toBeGreaterThan(EV_ALERT_RATIO);
  });

  it('is unbounded for a free hunt', () => {
    expect(safeEntrantCeiling(0, 50)).toBe(Number.POSITIVE_INFINITY);
  });

  it('shows the configured fees survive a crowded hunt but not an unlimited one', () => {
    // Worth stating plainly: entry fees work while hunts stay small. Past the
    // ceiling, prizes have to scale with entrants or the fee has to go.
    expect(safeEntrantCeiling(ENTRY_FEE_CENTS.med, prizeCentsFor('med'))).toBeGreaterThan(20);
    expect(safeEntrantCeiling(ENTRY_FEE_CENTS.hard, prizeCentsFor('hard'))).toBeGreaterThan(20);
    expect(safeEntrantCeiling(ENTRY_FEE_CENTS.med, prizeCentsFor('med'))).toBeLessThan(1_000);
  });
});

describe('quoting an entry', () => {
  it('offers a free route whenever the player has energy', () => {
    // Energy already gates play without money. Keeping a no-cost path to every
    // prize is better for players and reduces regulatory exposure.
    const q = quoteEntry('hard', 'human', 8, true);
    expect(q.freeEntryAvailable).toBe(true);
    expect(q.feeCents).toBeGreaterThan(0);
  });

  it('reports the fee when there is no energy left', () => {
    const q = quoteEntry('med', 'human', 8, false);
    expect(q.freeEntryAvailable).toBe(false);
    expect(q.feeCents).toBe(ENTRY_FEE_CENTS.med);
    expect(q.prizeCents).toBe(prizeCentsFor('med'));
    expect(q.rational).toBe(true);
  });

  it('flags a hunt that has grown past rationality', () => {
    const q = quoteEntry('med', 'agent', 10_000, false);
    expect(q.rational).toBe(false);
  });

  it('treats an empty hunt as one entrant rather than dividing by zero', () => {
    const q = quoteEntry('med', 'human', 0, false);
    expect(Number.isFinite(q.evRatio)).toBe(true);
    expect(q.rational).toBe(true);
  });

  it('charges agent and human zones the same today', () => {
    // The split exists in the model so human zones CAN carry a higher fee later;
    // nothing depends on them differing yet, and this pins that.
    expect(feeCentsFor('med', 'agent')).toBe(feeCentsFor('med', 'human'));
  });
});
