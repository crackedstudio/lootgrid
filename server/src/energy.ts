import { ENERGY, PASS } from './config';
import type { Player } from './types';

export interface EnergyView {
  value: number;
  max: number;
  nextRegenMs: number;
  /** Whether a Cycle Pass is speeding this up. Shown, never inferred. */
  boosted: boolean;
}

/**
 * How fast this player's bar refills.
 *
 * The Cycle Pass sells *tempo*, which is the category the review marks freely
 * sellable — it buys attempts at finding, never a chance at winning. A pass
 * holder digs more; they do not get a sixth key and their hints are not truer.
 *
 * Read from the player row rather than looked up, so this function stays pure
 * and stays off a database handle. See migration 017.
 */
export function regenMsFor(p: Player, now: number): number {
  const active = p.passUntil !== null && p.passUntil > now;
  return active ? Math.round(ENERGY.regenMs / PASS.regenMultiplier) : ENERGY.regenMs;
}

/**
 * Energy is computed, never ticked. No interval per player, no drift, and a
 * client that reloads or fiddles with its clock gets the same answer.
 *
 * The rate can change mid-window when a pass starts or ends. That is accepted
 * rather than modelled: the whole elapsed span is priced at the current rate,
 * which slightly favours the player at the moment a pass begins and slightly
 * favours us at the moment one lapses. Tracking rate changes exactly would mean
 * storing an interval history for a few points of energy.
 */
export function currentEnergy(p: Player, now: number): number {
  const regen = Math.floor((now - p.energyAt) / regenMsFor(p, now));
  return Math.min(ENERGY.max, p.energyValue + Math.max(0, regen));
}

export function view(p: Player, now: number): EnergyView {
  const rate = regenMsFor(p, now);
  const value = currentEnergy(p, now);
  const elapsed = (now - p.energyAt) % rate;
  return {
    value,
    max: ENERGY.max,
    nextRegenMs: value >= ENERGY.max ? 0 : rate - elapsed,
    boosted: rate !== ENERGY.regenMs,
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
  const partial = (now - p.energyAt) % regenMsFor(p, now);
  p.energyValue = value - cost;
  p.energyAt = now - partial;
  return { ok: true, energy: view(p, now) };
}

export function refund(p: Player, amount: number, now: number): EnergyView {
  const partial = (now - p.energyAt) % regenMsFor(p, now);
  p.energyValue = Math.min(ENERGY.max, currentEnergy(p, now) + amount);
  p.energyAt = now - partial;
  return view(p, now);
}
