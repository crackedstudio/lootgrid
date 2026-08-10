import { ENERGY } from './config';
import type { Player } from './types';

export interface EnergyView {
  value: number;
  max: number;
  nextRegenMs: number;
}

/**
 * Energy is computed, never ticked. No interval per player, no drift, and a
 * client that reloads or fiddles with its clock gets the same answer.
 */
export function currentEnergy(p: Player, now: number): number {
  const regen = Math.floor((now - p.energyAt) / ENERGY.regenMs);
  return Math.min(ENERGY.max, p.energyValue + Math.max(0, regen));
}

export function view(p: Player, now: number): EnergyView {
  const value = currentEnergy(p, now);
  const elapsed = (now - p.energyAt) % ENERGY.regenMs;
  return {
    value,
    max: ENERGY.max,
    nextRegenMs: value >= ENERGY.max ? 0 : ENERGY.regenMs - elapsed,
  };
}

/**
 * Compute-then-decrement in one synchronous pass. In production this is a Redis
 * Lua script because the state is shared across processes; inside one Node
 * process a function that never awaits is already atomic, and pretending
 * otherwise would be theatre.
 */
export function spend(p: Player, cost: number, now: number): { ok: boolean; energy: EnergyView } {
  const value = currentEnergy(p, now);
  if (value < cost) return { ok: false, energy: view(p, now) };

  // Preserve partial regen progress so spending doesn't reset the timer.
  const partial = (now - p.energyAt) % ENERGY.regenMs;
  p.energyValue = value - cost;
  p.energyAt = now - partial;
  return { ok: true, energy: view(p, now) };
}

export function refund(p: Player, amount: number, now: number): EnergyView {
  const partial = (now - p.energyAt) % ENERGY.regenMs;
  p.energyValue = Math.min(ENERGY.max, currentEnergy(p, now) + amount);
  p.energyAt = now - partial;
  return view(p, now);
}
