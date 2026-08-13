import { describe, expect, it } from 'vitest';
import {
  MAX_PRIZE_CENTS,
  PRIZE_CENTS,
  formatPrize,
  prizeCentsFor,
  prizeLabelFor,
  toTokenUnits,
} from './prizes';

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
    expect(formatPrize(50)).toBe('$0.50');
    expect(formatPrize(500)).toBe('$5.00');
    expect(prizeLabelFor('med')).toBe('$0.50');
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
