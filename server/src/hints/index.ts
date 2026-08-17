import * as hintRepo from '../db/repos/hints';
import { logger } from '../logger';
import * as metrics from '../metrics';
import type { Hunt } from '../types';
import { COMMIT_VERSION, commitmentFor } from './commit';
import { hintDrops, hintIndex, hintsForHunt } from './generate';
import type { Hint, HintRecord } from './types';

/**
 * Hint service: generation on demand, ownership, and the public projection.
 *
 * Mirrors `store.blockGame` — the set is a pure function of the hunt's salt, so
 * it is generated on first need and persisted from then on. Persisting a
 * derivable thing is deliberate: phase 2 commits to the exact bytes, phase 5
 * trades against stable ids, and a later change to the generator must not
 * rewrite hints players already hold.
 */

/** The hunt's hint set, generating and persisting it the first time it is asked for. */
export function forHunt(hunt: Hunt, now = Date.now()): HintRecord[] {
  const existing = hintRepo.forHunt(hunt.id);
  if (existing.length > 0) return existing;

  const generated = hintsForHunt(hunt);
  hintRepo.insertMany(generated, now);
  return generated;
}

/**
 * Generate the hint set and publish its commitment, at hunt creation.
 *
 * The caller runs this inside the same transaction as the hunt insert. Doing it
 * eagerly rather than on first read is the point: the commitment has to exist
 * before anyone can play, or it proves nothing about what was decided in
 * advance.
 */
export function commitAtCreation(hunt: Hunt, now = Date.now()): string {
  const set = forHunt(hunt, now);
  const commitment = commitmentFor(hunt.id, hunt.salt, set);
  hintRepo.putCommitment(hunt.id, hunt.zoneId, hunt.epoch, commitment, COMMIT_VERSION, now);
  return commitment;
}

/**
 * Open a hunt's hint set to public inspection, once it can no longer be played.
 *
 * Called when a hunt resolves or expires — the same moment the salt is revealed.
 * Never throws: settlement has already happened, and a bookkeeping failure here
 * must not disturb it.
 */
export function revealForHunt(huntId: string, now = Date.now()): void {
  try {
    hintRepo.reveal(huntId, now);
  } catch (err) {
    logger.warn({ err, huntId }, 'hint reveal failed — settlement stands');
  }
}

/**
 * Strip a hint to what a player may see.
 *
 * `isTrue` and `idx` stay behind: the first is the answer to the game, the
 * second leaks position within a set whose ordering correlates with tier. A
 * player gets the advertised reliability of the tier and nothing more — the
 * odds, never the outcome.
 */
export function toPublic(h: HintRecord): Hint {
  return {
    id: h.id,
    huntId: h.huntId,
    zoneId: h.zoneId,
    epoch: h.epoch,
    tier: h.tier,
    reliabilityBps: h.reliabilityBps,
    payload: h.payload,
    expiresAt: h.expiresAt,
  };
}

/**
 * Award a hint for revealing a cell, if this cell earns one.
 *
 * Fixed by the zone salt, the player and the cell, so it cannot be re-rolled: a
 * cell is revealable exactly once, by exactly one player. Returns the hint when
 * one was granted, otherwise null.
 *
 * **Never throws.** A reveal has already cost the player energy and been
 * committed by the time this runs; a hint that fails to generate is a missing
 * bonus, not a reason to fail the request. Same rule the relayer follows.
 */
export function awardForReveal(
  zoneSalt: string,
  playerId: string,
  r: number,
  c: number,
  liveHunts: Hunt[],
  now = Date.now(),
  opts: { guaranteed?: boolean; wantTrue?: boolean } = {},
): Hint | null {
  try {
    if (liveHunts.length === 0) return null;

    // ─────────────────── which treasure a hint is about ───────────────────
    //
    // The nearest one to the tile you just dug.
    //
    // This used to be drawn from the same hash as the drop, with the stated
    // aim that "a player cannot steer their hints towards a hunt they have
    // already narrowed down". That rule was written when a zone held four
    // treasures. A zone now holds twenty-four, and scattering across all of
    // them does not prevent steering so much as prevent *aggregation*:
    // measured over 300 digs it produced 80 hints spread across 11 different
    // treasures and not one about the hunt that carried the money. Three hints
    // about the same treasure — the thing the whole deduction loop is built on
    // — was not merely expensive, it was unreachable.
    //
    // Nearest-first is steerable, and that is the point rather than a
    // concession. To aim your hints you must dig where you think the treasure
    // is, which costs energy and is exactly the feedback loop exploration is
    // supposed to have. What the old rule actually protected against — buying
    // your way to a stack of hints on one hunt without paying to explore — is
    // still protected, because digging is the only free path and it is priced.
    //
    // Choosing a target *without* digging near it is a separate thing, and it
    // is a product rather than a default: the Prospector's Compass. It stays
    // unbuilt here.
    // `guaranteed` skips the drop roll — a clue and a trap both always pay. The
    // roll is still what decides *which* hint, so neither is a stronger hint,
    // only a certain one.
    if (!opts.guaranteed && !hintDrops(zoneSalt, playerId, r, c)) return null;

    // Nearest first, then outward.
    //
    // Ordinary digs never look past the first entry. A trap does, and it has to:
    // it owes the player a *false* hint, and a hunt's committed set of six is
    // true throughout about one time in seven. Falling back to a true hint there
    // would quietly make a trap an expensive clue — the label would mean
    // nothing again, which is the whole problem this phase exists to fix.
    //
    // Walking outward keeps every hint drawn from a set that was published in
    // advance, which is what the honesty audit rests on. The cost is that a
    // trap's lie is occasionally about a treasure slightly further away, and
    // that is a far smaller lie than a trap that tells the truth.
    const ordered = byDistance(liveHunts, r, c);

    let hint: HintRecord | null = null;
    for (const candidate of ordered) {
      const pool = forHunt(candidate, now);
      if (pool.length === 0) continue;
      hint = pickFrom(pool, zoneSalt, playerId, r, c, opts.wantTrue);
      if (hint) break;
    }
    if (!hint) return null;

    const fresh = hintRepo.grant(playerId, hint.id, 'reveal', now);
    if (fresh) {
      metrics.hintsAwarded.inc({ tier: String(hint.tier) });
    }
    return toPublic(hint);
  } catch (err) {
    logger.warn({ err, playerId, r, c }, 'hint award failed — reveal stands');
    return null;
  }
}

/**
 * Live hunts ordered by Chebyshev distance from a cell, nearest first.
 *
 * Ties break on hunt id rather than storage order, so the answer does not
 * depend on how the rows happened to come back — two players digging the same
 * tile must get hints about the same treasure.
 */
export function byDistance(liveHunts: Hunt[], r: number, c: number): Hunt[] {
  const d = (h: Hunt) => Math.max(Math.abs(h.r - r), Math.abs(h.c - c));
  return [...liveHunts].sort((a, b) => d(a) - d(b) || (a.id < b.id ? -1 : 1));
}

/** The single closest live hunt. */
export const nearestHunt = (liveHunts: Hunt[], r: number, c: number): Hunt =>
  byDistance(liveHunts, r, c)[0]!;

/**
 * Which hint from the set, optionally constrained to true or false ones.
 *
 * `wantTrue: false` is what a trap tile hands out. It draws from the hunt's
 * **already-committed** set rather than fabricating anything, which is what
 * keeps the honesty audit intact: `hints/stats.ts` measures the accuracy of the
 * committed set against its advertised tier rates, and that set is unchanged by
 * which member of it a given tile happens to grant.
 *
 * Returns null when this set has none of the requested kind, rather than
 * substituting one of the other kind. The caller walks outward to the next
 * hunt — a trap that cannot find a lie here looks somewhere else rather than
 * handing over the truth and calling it a trap.
 */
function pickFrom(
  pool: HintRecord[],
  zoneSalt: string,
  playerId: string,
  r: number,
  c: number,
  wantTrue?: boolean,
): HintRecord | null {
  const from = wantTrue === undefined ? pool : pool.filter(h => h.isTrue === wantTrue);
  if (from.length === 0) return null;
  const which = hintIndex(zoneSalt, playerId, r, c, from.length);
  return from[which ?? 0] ?? null;
}

/** A player's unexpired hints, newest first, safe to serialise. */
export function forPlayer(playerId: string, now = Date.now()): Hint[] {
  return hintRepo.ofPlayer(playerId, now).map(toPublic);
}

export function countForPlayer(playerId: string, now = Date.now()): number {
  return hintRepo.countOfPlayer(playerId, now);
}

/**
 * How many live hints the player holds about this hunt.
 *
 * The Crack's tiebreak reads this at the moment an answer is locked. "Held"
 * rather than "applied" is deliberate — there is no apply endpoint, because a
 * player who has seen a hint cannot un-see it before picking, so held is the
 * honest measure of how much information was bought before answering.
 */
export function countForHunt(playerId: string, huntId: string, now = Date.now()): number {
  return hintRepo.ofPlayer(playerId, now).filter(h => h.huntId === huntId).length;
}

/**
 * Whether the player holds any live hint pointing at this hunt.
 *
 * Drives phase 1's gate metric. Says nothing about whether those hints were
 * true or whether the player believed them — only that they had information
 * about this hunt when they entered it.
 */
export function heldForHunt(playerId: string, huntId: string, now = Date.now()): boolean {
  return hintRepo.ofPlayer(playerId, now).some(h => h.huntId === huntId);
}

export * from './types';
