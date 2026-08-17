import { KEYS } from './config';
import * as attemptRepo from './db/repos/attempts';

/**
 * Keys: how many cash hunts one identity may enter in a day.
 *
 * ─────────────────────────── the sentence this enforces ─────────────────────
 *
 * > Someone who spends $20 does not get more chances to win our money. They
 * > get a better-informed five.
 *
 * That boundary does four things at once. It kills pay-to-win. It kills
 * fake-account farming, because the ceiling is per identity rather than per
 * dollar. It gives the hint market a supply side, since energy spent
 * manufacturing hints has no cap while energy spent competing does. And it is
 * what moves this off the gambling line: money buys information and
 * exploration, never a chance at a prize. That last one is the sentence handed
 * to a lawyer.
 *
 * ─────────────────────────── why there is no balance ────────────────────────
 *
 * A key is not a token, a column, or a row. It is a **count of cash attempts
 * already recorded today**, subtracted from a constant.
 *
 * That is the whole design and it is deliberate. A stored balance would need a
 * credit path — for the daily reset, for a refund, for a support tool — and
 * every one of those is a function that adds keys to an account. Once such a
 * function exists, "keys cannot be bought" is a policy that some future caller
 * has to remember, and policies are forgotten. Derived from history, there is
 * no code path anywhere in this server that could grant one, and no way to
 * write a shop item that does. The rule is enforced by the absence of a
 * mechanism rather than by everyone's good behaviour.
 *
 * The cost is that a key is spent the moment an attempt is *created*, and is
 * not returned if the hunt reopens because everybody guessed wrong. That is the
 * right side to err on: one shot per block is already the rule, and a refund
 * path is exactly the credit path this design exists to avoid.
 *
 * ─────────────────────────── the cap is meant to be invisible ───────────────
 *
 * Most players will never find five cash treasures in a day — there are only
 * about four on the whole map. A good cap is invisible to normal players and
 * painful to abusers, and this one is sized to be exactly that.
 */

/** Start of the UTC day containing `now`. Fixed days, not a sliding window. */
export function dayStart(now: number): number {
  return Math.floor(now / KEYS.dayMs) * KEYS.dayMs;
}

export interface KeyBalance {
  /** Entries left today. Never negative. */
  remaining: number;
  /** The daily allowance. Constant, and constant for everyone. */
  perDay: number;
  used: number;
  /** When the allowance resets, so a client can show a countdown. */
  resetsAt: number;
}

export function balance(playerId: string, now = Date.now()): KeyBalance {
  const from = dayStart(now);
  const used = attemptRepo.countCashSince(playerId, from);
  return {
    remaining: Math.max(0, KEYS.perDay - used),
    perDay: KEYS.perDay,
    used,
    resetsAt: from + KEYS.dayMs,
  };
}

/** Whether this player may enter another cash hunt today. */
export const hasKey = (playerId: string, now = Date.now()): boolean =>
  balance(playerId, now).remaining > 0;
