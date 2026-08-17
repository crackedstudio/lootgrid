import { RANK } from './config';
import * as hintRepo from './db/repos/hints';

/**
 * Prospector rank — what a cash hunt is gated on.
 *
 * ─────────────────────────── the threat it answers ──────────────────────────
 *
 * One person with fifty wallets is the biggest threat to a pot with real money
 * in it, and anti-bot detection does not touch it: those are not scripts, they
 * are a human clicking. Every other defence in the system raises the *cost* of
 * a burner — private fog makes each one pay its own exploration, keys cap what
 * each can extract. This one raises the *time*, which is the axis an attacker
 * cannot buy their way along.
 *
 * ─────────────────────────── two different things ───────────────────────────
 *
 * The gate and the ladder are not the same measurement, and conflating them
 * would break both.
 *
 * **The gate is time and volume.** To be ranked at all you need hints that have
 * *resolved* — held on hunts that have since closed — across several distinct
 * days. A wallet created this morning cannot satisfy that at any price, because
 * hunts close on their own schedule and days pass at one per day. This is the
 * anti-sybil half and it is deliberately dull.
 *
 * **The ladder is accuracy.** Above the gate, tier comes from how often the
 * hints you held turned out to be true. This is the half players see and the
 * half the review asks for — status earned by being a good prospector rather
 * than by having won money.
 *
 * ─────────────────────────── what accuracy really measures ──────────────────
 *
 * Be honest about this, because it changes as the game grows.
 *
 * For a player who only digs, accuracy is substantially luck: hints are granted
 * by the drop roll, not chosen, and a tier-3 hint is a coin flip by design. What
 * a digger's number really shows is tier mix and volume.
 *
 * It becomes skill for two kinds of player. Someone who *buys* hints chooses
 * which to buy and from whom, so their number reflects those judgements. Someone
 * who *sells* is already bonded against selling lies (market/enforcement.ts),
 * and their number is the same fact the bond is posted against.
 *
 * So the ladder is weakest for exactly the players the gate is not aimed at, and
 * sharpest for the ones trading real money. That is an acceptable shape, but it
 * is a reason to keep the *gate* on time rather than on accuracy — a burner farm
 * with lucky hints must not be able to rank up.
 */

export type RankTier = 'unranked' | 'prospector' | 'surveyor' | 'cartographer';

/** Ascending. Index is the tier's ordinal, used for comparisons. */
export const TIERS: RankTier[] = ['unranked', 'prospector', 'surveyor', 'cartographer'];

export const ordinalOf = (tier: RankTier): number => TIERS.indexOf(tier);

export interface RankReport {
  tier: RankTier;
  /** Hints held on hunts that have since closed. The sample accuracy rests on. */
  resolved: number;
  /** How many of those turned out true, in basis points. */
  accuracyBps: number;
  /** Distinct UTC days on which this player acquired a hint. */
  activeDays: number;
  /** What is still missing to reach the next tier, for an honest refusal. */
  nextTier: RankTier | null;
  shortfall: { resolved: number; activeDays: number; accuracyBps: number };
}

/**
 * Whether the gate is even open. Time and volume only — never accuracy.
 *
 * Separated from tier so that the sybil question and the status question can be
 * read independently, and so a future change to the ladder cannot accidentally
 * open the gate.
 */
function meetsGate(resolved: number, activeDays: number): boolean {
  return resolved >= RANK.minResolvedHints && activeDays >= RANK.minActiveDays;
}

export function rankOf(playerId: string, now = Date.now()): RankReport {
  const stats = hintRepo.resolvedAccuracy(playerId, now);
  const { resolved, trueCount, activeDays } = stats;
  const accuracyBps = resolved === 0 ? 0 : Math.round((trueCount / resolved) * 10_000);

  let tier: RankTier = 'unranked';
  if (meetsGate(resolved, activeDays)) {
    tier = 'prospector';
    if (resolved >= RANK.surveyor.resolved && accuracyBps >= RANK.surveyor.accuracyBps) {
      tier = 'surveyor';
    }
    if (resolved >= RANK.cartographer.resolved && accuracyBps >= RANK.cartographer.accuracyBps) {
      tier = 'cartographer';
    }
  }

  const next = TIERS[ordinalOf(tier) + 1] ?? null;
  return {
    tier,
    resolved,
    accuracyBps,
    activeDays,
    nextTier: next,
    shortfall: shortfallTo(next, resolved, activeDays, accuracyBps),
  };
}

/**
 * What is still missing, so a refusal can say so.
 *
 * "You are not ranked highly enough" with no number is the kind of message that
 * makes people assume the game is rigged against them. Telling someone they need
 * two more days is a thing they can act on, and it gives away nothing an
 * attacker does not already know from this file.
 */
function shortfallTo(
  next: RankTier | null,
  resolved: number,
  activeDays: number,
  accuracyBps: number,
): RankReport['shortfall'] {
  const none = { resolved: 0, activeDays: 0, accuracyBps: 0 };
  if (!next) return none;

  const need =
    next === 'prospector'
      ? { resolved: RANK.minResolvedHints, activeDays: RANK.minActiveDays, accuracyBps: 0 }
      : next === 'surveyor'
        ? { ...RANK.surveyor, activeDays: RANK.minActiveDays }
        : { ...RANK.cartographer, activeDays: RANK.minActiveDays };

  return {
    resolved: Math.max(0, need.resolved - resolved),
    activeDays: Math.max(0, need.activeDays - activeDays),
    accuracyBps: Math.max(0, need.accuracyBps - accuracyBps),
  };
}

/** Whether this player may enter a cash hunt on rank grounds. */
export const canEnterCash = (playerId: string, now = Date.now()): boolean =>
  ordinalOf(rankOf(playerId, now).tier) >= ordinalOf(RANK.minTierForCash);
