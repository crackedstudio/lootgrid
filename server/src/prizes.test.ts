import { describe, expect, it } from 'vitest';
import { AGENT_CASH_PER_ZONE, CASH_PER_ZONE, cashPerZone } from './config';
import {
  AGENT_DIFFICULTY_WEIGHTS,
  DIFFICULTY_WEIGHTS,
  MAX_PRIZE_CENTS,
  MIN_VIABLE_PRIZE_CENTS,
  PRIZE_CENTS,
  difficultyForBlock,
  formatPrize,
  prizeCentsFor,
  prizeLabelFor,
  toTokenUnits,
} from './prizes';
import { randomHex } from './hash';
import type { Difficulty } from './types';

/**
 * Prize arithmetic.
 *
 * The unit conversion here decides how much leaves escrow, so an error is a
 * solvency bug rather than a display one. The contract's per-hunt cap is a
 * backstop, not a substitute for getting this right.
 */

describe('prize band', () => {
  it('stays inside the $0.01–$5.00 range the design settled on', () => {
    for (const cents of Object.values(PRIZE_CENTS)) {
      expect(cents).toBeGreaterThanOrEqual(1);
      expect(cents).toBeLessThanOrEqual(MAX_PRIZE_CENTS);
    }
  });

  it('rises with difficulty', () => {
    expect(PRIZE_CENTS.easy).toBeLessThan(PRIZE_CENTS.med);
    expect(PRIZE_CENTS.med).toBeLessThan(PRIZE_CENTS.hard);
  });

  it('formats for humans without floating point drift', () => {
    expect(formatPrize(1)).toBe('$0.01');
    expect(formatPrize(60)).toBe('$0.60');
    expect(formatPrize(500)).toBe('$5.00');
    expect(prizeLabelFor('med')).toBe('$1.20');
  });

  /**
   * No tier may pay so little that its hints cannot be sold.
   *
   * This is the constraint the 1c tier violated, and it is the reason the
   * market looked dead: a prize's hint ceiling is 25% of it, so anything under
   * ~4c cannot clear `MIN_TRADE_CENTS` at all. Sixty percent of hunts were
   * drawn in a tier whose inventory was unsellable by arithmetic.
   */
  it('keeps every tier above the market floor', () => {
    for (const [tier, cents] of Object.entries(PRIZE_CENTS)) {
      expect(cents, tier).toBeGreaterThanOrEqual(MIN_VIABLE_PRIZE_CENTS);
    }
  });

  it('falls back to the cheapest prize for an unknown difficulty', () => {
    // Over-paying on a bad input is the expensive direction to be wrong in.
    expect(prizeCentsFor('nonsense' as never)).toBe(PRIZE_CENTS.easy);
  });
});

describe('token unit conversion', () => {
  it('converts for 18-decimal tokens (cUSD, USDm)', () => {
    expect(toTokenUnits(1, 18)).toBe(10_000_000_000_000_000n); // $0.01
    expect(toTokenUnits(50, 18)).toBe(500_000_000_000_000_000n); // $0.50
    expect(toTokenUnits(500, 18)).toBe(5_000_000_000_000_000_000n); // $5.00
  });

  it('converts for 6-decimal tokens (USDC, USDT)', () => {
    expect(toTokenUnits(1, 6)).toBe(10_000n);
    expect(toTokenUnits(50, 6)).toBe(500_000n);
    expect(toTokenUnits(500, 6)).toBe(5_000_000n);
  });

  it('is exact where floating point would not be', () => {
    // 0.1 + 0.2 !== 0.3. At 18 decimals that class of error is worth real money.
    expect(toTokenUnits(10, 18) + toTokenUnits(20, 18)).toBe(toTokenUnits(30, 18));
    let sum = 0n;
    for (let i = 0; i < 100; i++) sum += toTokenUnits(1, 18);
    expect(sum).toBe(toTokenUnits(100, 18));
  });

  it('scales linearly across the whole band', () => {
    for (const d of [6, 18]) {
      expect(toTokenUnits(500, d)).toBe(toTokenUnits(1, d) * 500n);
    }
  });

  it('rejects inputs that would silently truncate', () => {
    expect(() => toTokenUnits(1.5, 18)).toThrow(/whole number/);
    expect(() => toTokenUnits(-1, 18)).toThrow(/non-negative/);
    expect(() => toTokenUnits(1, 1)).toThrow(/decimals/);
  });

  it('never exceeds the cap when converted', () => {
    // Mirrors the contract's perHuntCap check, in the units it is expressed in.
    const capAt18 = toTokenUnits(MAX_PRIZE_CENTS, 18);
    for (const cents of Object.values(PRIZE_CENTS)) {
      expect(toTokenUnits(cents, 18)).toBeLessThanOrEqual(capAt18);
    }
  });
});

describe('drawing a difficulty', () => {
  /** A realistic sample of blocks, drawn the way `replenish` draws them. */
  function sample(n: number): Difficulty[] {
    return Array.from({ length: n }, (_, i) => difficultyForBlock(randomHex(32), `ridge-1-3x4-${i}`));
  }

  it('is fixed by the salt and the hunt', () => {
    // A property of the BLOCK. If this could vary per call, the house would be
    // choosing who gets the cheap hunts.
    const salt = randomHex(32);
    expect(difficultyForBlock(salt, 'ridge-1-3x4-aaa')).toBe(
      difficultyForBlock(salt, 'ridge-1-3x4-aaa'),
    );
  });

  it('differs across blocks in the same zone', () => {
    const salt = randomHex(32);
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => difficultyForBlock(salt, `h-${i}`)));
    expect(drawn.size).toBeGreaterThan(1);
  });

  it('uses every tier, so none of the modules’ tables are dead code', () => {
    // Each game module has carried easy/med/hard tables since phase 0; a draw
    // that never reached two of them is why they never ran.
    expect(new Set(sample(4_000))).toEqual(new Set(['easy', 'med', 'hard']));
  });

  it('lands near the advertised weights', () => {
    const draws = sample(20_000);
    for (const [difficulty, weight] of DIFFICULTY_WEIGHTS) {
      const observed = (draws.filter(d => d === difficulty).length / draws.length) * 100;
      // Wide enough not to flake, tight enough to catch a table edited without
      // the arithmetic below being revisited.
      expect(Math.abs(observed - weight)).toBeLessThan(3);
    }
  });

  /**
   * The treasury has to survive its own grid.
   *
   * This is the check the phase 2 resize turns on. Twenty-four treasures per
   * zone is the density a 3,600-cell map needs to feel inhabited, and twenty-
   * four *funded* hunts per zone would burn about $168/day against a
   * self-funded floor of $100–300 a MONTH. `CASH_PER_ZONE` is what reconciles
   * them, so its value is a solvency parameter rather than a game-feel one and
   * belongs under test.
   */
  it('funds the grid inside the self-funded monthly floor', () => {
    const evFor = (weights: typeof DIFFICULTY_WEIGHTS) => {
      const total = weights.reduce((sum, [, w]) => sum + w, 0);
      return weights.reduce((sum, [d, w]) => sum + (w / total) * prizeCentsFor(d), 0);
    };

    expect(evFor(DIFFICULTY_WEIGHTS)).toBeCloseTo(114.4, 1);

    // Cash hunts created per day = zones × CASH_PER_ZONE ÷ TTL in days.
    // Four human zones on a 24h TTL, one agent zone on 72h — see store's
    // ZONE_SEED and config's ASYNC block.
    const perDayCents =
      (4 * CASH_PER_ZONE) / 1 * evFor(DIFFICULTY_WEIGHTS) +
      (1 * CASH_PER_ZONE) / 3 * evFor(AGENT_DIFFICULTY_WEIGHTS);
    const perMonth = (perDayCents * 30) / 100;

    expect(perMonth).toBeGreaterThan(100);
    expect(perMonth).toBeLessThan(300);
    // Deliberately in the lower half: the headline prize is meant to be
    // concentrated into one weekly final, and routine hunts should not have
    // spent the whole budget before that exists.
    expect(perMonth).toBeLessThan(200);
  });

  it('leaves headroom under the escrow per-day claim cap', () => {
    // Worst case is every live cash hunt drawn hard AND claimed on the same
    // day. A cap that binds turns a legitimate win into a revert.
    const liveCash = 5 * CASH_PER_ZONE;
    expect(liveCash * MAX_PRIZE_CENTS).toBeLessThan(10_000);
  });

  it('never draws a prize above the per-hunt cap', () => {
    for (const d of sample(500)) {
      expect(prizeCentsFor(d)).toBeLessThanOrEqual(MAX_PRIZE_CENTS);
    }
  });

  it('weights sum to 100, so the table reads as percentages', () => {
    expect(DIFFICULTY_WEIGHTS.reduce((sum, [, w]) => sum + w, 0)).toBe(100);
  });
});

describe('how many hunts carry a prize', () => {
  /**
   * The ratio that silently disabled the agent tier.
   *
   * Only CASH hunts draw agent-playable games — `gameTypeForBlock` sends every
   * puzzle hunt to the reflex pool regardless of zone kind, deliberately, since
   * puzzle hunts guard XP rather than money. So a 24-hunt agent zone holding a
   * single cash hunt offers agents exactly one thing to play, and nothing at all
   * between its resolution and the next restock.
   *
   * The same ratio is fine on a human zone, where the other 23 hunts are
   * playable. That is why it went unnoticed.
   */
  it('gives agent zones more prize hunts than human ones', () => {
    expect(cashPerZone('agent')).toBeGreaterThan(cashPerZone('human'));
  });

  it('leaves an agent zone something to play while one resolves', () => {
    // One is the broken case: the tier stops the moment that hunt is taken.
    expect(cashPerZone('agent')).toBeGreaterThan(1);
  });

  it('does not raise human zones, whose budget the world cost is sized on', () => {
    expect(cashPerZone('human')).toBe(CASH_PER_ZONE);
  });

  /**
   * A budget guard, not a style rule. Cash hunts are funded prizes: the config
   * comment prices the whole world at ~$161/month with this value, and the band
   * it must stay inside is $100–300. A large bump here spends real money.
   */
  it('keeps the agent-zone count inside what the prize budget was sized for', () => {
    expect(AGENT_CASH_PER_ZONE).toBeLessThanOrEqual(6);
  });
});
