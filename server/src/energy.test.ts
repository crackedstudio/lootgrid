import { describe, expect, it } from 'vitest';
import { ENERGY } from './config';
import { currentEnergy, refund, spend, view } from './energy';
import type { Player } from './types';

function player(value: number, at: number): Player {
  return {
    id: '0xabc',
    handle: '@abc',
    sessionKey: null,
    energyValue: value,
    energyAt: at,
    trustScore: 1,
    shadowBanned: false,
  xp: 0,
  passUntil: null,
  passToppedUpAt: null,
    createdAt: at,
  };
}

const T0 = 1_700_000_000_000;

describe('energy', () => {
  it('regenerates one unit per interval', () => {
    const p = player(5, T0);
    expect(currentEnergy(p, T0)).toBe(5);
    expect(currentEnergy(p, T0 + ENERGY.regenMs - 1)).toBe(5);
    expect(currentEnergy(p, T0 + ENERGY.regenMs)).toBe(6);
    expect(currentEnergy(p, T0 + ENERGY.regenMs * 3)).toBe(8);
  });

  it('caps at the maximum', () => {
    const p = player(5, T0);
    expect(currentEnergy(p, T0 + ENERGY.regenMs * 1000)).toBe(ENERGY.max);
  });

  it('never regenerates backwards when the clock jumps', () => {
    const p = player(5, T0);
    expect(currentEnergy(p, T0 - 60_000)).toBe(5);
  });

  it('spends when affordable', () => {
    const p = player(5, T0);
    const res = spend(p, 3, T0);
    expect(res.ok).toBe(true);
    expect(res.energy.value).toBe(2);
    expect(currentEnergy(p, T0)).toBe(2);
  });

  it('refuses to overspend and leaves the balance untouched', () => {
    const p = player(2, T0);
    const res = spend(p, 3, T0);
    expect(res.ok).toBe(false);
    expect(currentEnergy(p, T0)).toBe(2);
  });

  it('spends accumulated regen', () => {
    const p = player(0, T0);
    const later = T0 + ENERGY.regenMs * 4;
    expect(spend(p, 3, later).ok).toBe(true);
    expect(currentEnergy(p, later)).toBe(1);
  });

  it('preserves partial regen progress across a spend', () => {
    const p = player(5, T0);
    // Two-thirds of the way to the next unit.
    const partway = T0 + Math.floor(ENERGY.regenMs * 0.66);
    spend(p, 1, partway);
    // The remaining third should still tick over on schedule, not restart.
    expect(currentEnergy(p, T0 + ENERGY.regenMs)).toBe(5);
  });

  it('refunds without exceeding the cap', () => {
    const p = player(ENERGY.max - 1, T0);
    const res = refund(p, 5, T0);
    expect(res.value).toBe(ENERGY.max);
  });

  it('reports time until the next regen', () => {
    const p = player(5, T0);
    expect(view(p, T0).nextRegenMs).toBe(ENERGY.regenMs);
    expect(view(p, T0 + 1000).nextRegenMs).toBe(ENERGY.regenMs - 1000);
  });

  it('reports no pending regen at full energy', () => {
    const p = player(ENERGY.max, T0);
    expect(view(p, T0).nextRegenMs).toBe(0);
  });

  it('cannot be double-spent by two calls at the same instant', () => {
    const p = player(3, T0);
    expect(spend(p, 3, T0).ok).toBe(true);
    // The second call sees the decremented balance, because spend is
    // compute-then-write in one synchronous pass.
    expect(spend(p, 3, T0).ok).toBe(false);
  });
});
