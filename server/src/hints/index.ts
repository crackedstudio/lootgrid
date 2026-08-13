import * as hintRepo from '../db/repos/hints';
import { logger } from '../logger';
import * as metrics from '../metrics';
import type { Hunt } from '../types';
import { COMMIT_VERSION, commitmentFor } from './commit';
import { hintDrop, hintsForHunt } from './generate';
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
): Hint | null {
  try {
    if (liveHunts.length === 0) return null;

    // Which hunt this cell speaks to is itself part of the draw, so a player
    // cannot steer their hints towards a hunt they have already narrowed down.
    const huntIdx = hintDrop(zoneSalt, playerId, r, c, liveHunts.length);
    if (huntIdx === null) return null;

    const hunt = liveHunts[huntIdx]!;
    const pool = forHunt(hunt, now);
    if (pool.length === 0) return null;

    const which = hintDrop(zoneSalt, playerId, r, c, pool.length);
    if (which === null) return null;

    const hint = pool[which]!;
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

/** A player's unexpired hints, newest first, safe to serialise. */
export function forPlayer(playerId: string, now = Date.now()): Hint[] {
  return hintRepo.ofPlayer(playerId, now).map(toPublic);
}

export function countForPlayer(playerId: string, now = Date.now()): number {
  return hintRepo.countOfPlayer(playerId, now);
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
