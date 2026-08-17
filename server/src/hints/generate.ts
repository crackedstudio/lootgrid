import { GRID } from '../config';
import { hashInt } from '../hash';
import type { Hunt } from '../types';
import {
  COL_BAND_HALF,
  HINTS_PER_HUNT,
  MID_COL,
  MID_ROW,
  RING_RADII,
  ROW_BAND_HALF,
  TIER_RELIABILITY_BPS,
  cellMatches,
  quadrantOf,
  type HintPayload,
  type HintRecord,
  type HintTier,
  type Quadrant,
} from './types';

/**
 * Deterministic hint generation.
 *
 * Everything here is a pure function of the hunt's salt, which is fixed at hunt
 * creation and revealed at settlement. Two consequences, both load-bearing:
 *
 *   1. The same hunt always produces the same hint set, so phase 2 can commit to
 *      it before anyone enters and reveal it afterwards.
 *   2. Truth flags are fixed **before the game knows who is playing**. The house
 *      cannot make your hint the false one, because your identity is not an
 *      input. Preserve that property in phase 8 when the Director takes over.
 *
 * A false hint is not a broken hint. It describes a plausible decoy at the same
 * precision as a true one, so it is indistinguishable from the outside — which
 * is the entire point. What a player is buying is a probability, published per
 * tier, not a fact.
 */

/** Tier of the i-th hint. Weighted towards the middle so a set is usually mixed. */
function tierFor(salt: string, huntId: string, idx: number): HintTier {
  const roll = hashInt(salt, huntId, `tier:${idx}`) % 100;
  if (roll < 35) return 1;
  if (roll < 75) return 2;
  return 3;
}

/**
 * Whether hint `idx` tells the truth.
 *
 * Deterministic, and drawn against the tier's *advertised* reliability so the
 * published number and the generated reality cannot drift apart. Phase 2's audit
 * compares observed accuracy back to `TIER_RELIABILITY_BPS`; if this used any
 * other distribution that check would fail, which is the intended safeguard.
 */
function truthFor(salt: string, huntId: string, idx: number, tier: HintTier): boolean {
  return hashInt(salt, huntId, `truth:${idx}`) % 10_000 < TIER_RELIABILITY_BPS[tier];
}

/**
 * A decoy cell for a false hint: deterministic, and guaranteed to differ from
 * the real one. Without the guarantee a "false" hint could accidentally describe
 * the truth, which would quietly inflate observed accuracy above the advertised
 * rate and break phase 2's audit.
 */
function decoyCell(salt: string, huntId: string, idx: number, real: { r: number; c: number }) {
  const total = GRID.rows * GRID.cols;
  const realIdx = real.r * GRID.cols + real.c;
  // Offset by 1..total-1 so the result can never land back on the real cell.
  const offset = 1 + (hashInt(salt, huntId, `decoy:${idx}`) % (total - 1));
  const pick = (realIdx + offset) % total;
  return { r: Math.floor(pick / GRID.cols), c: pick % GRID.cols };
}

/** A quadrant that is *not* the given one, chosen deterministically. */
function otherQuadrant(salt: string, huntId: string, idx: number, not: Quadrant): Quadrant {
  const others = (['NW', 'NE', 'SW', 'SE'] as Quadrant[]).filter(q => q !== not);
  return others[hashInt(salt, huntId, `quad:${idx}`) % others.length]!;
}

function clampBand(centre: number, half: number, max: number): { from: number; to: number } {
  const from = Math.max(0, centre - half);
  const to = Math.min(max - 1, centre + half);
  return { from, to };
}

/**
 * Build the payload for one hint.
 *
 * `target` is the real cell for a true hint and a decoy for a false one, so every
 * shape below is written once and describes whichever cell it was handed. The
 * exception is `exclusion`, whose polarity is inverted: excluding a quadrant that
 * does not contain the hunt is *true*, so a lie must name the one that does.
 */
function payloadFor(
  salt: string,
  huntId: string,
  idx: number,
  tier: HintTier,
  isTrue: boolean,
  real: { r: number; c: number },
): HintPayload {
  const target = isTrue ? real : decoyCell(salt, huntId, idx, real);
  const shapeRoll = hashInt(salt, huntId, `shape:${idx}`);

  if (tier === 1) {
    // Broad: name a quadrant, or rule one out.
    if (shapeRoll % 2 === 0) {
      return { kind: 'region', quadrant: quadrantOf(target.r, target.c) };
    }
    const realQuad = quadrantOf(real.r, real.c);
    return {
      kind: 'exclusion',
      // True: exclude somewhere the hunt is not. False: exclude where it is.
      quadrant: isTrue ? otherQuadrant(salt, huntId, idx, realQuad) : realQuad,
    };
  }

  if (tier === 2) {
    switch (shapeRoll % 3) {
      case 0:
        return { kind: 'rowBand', ...clampBand(target.r, ROW_BAND_HALF, GRID.rows) };
      case 1:
        return { kind: 'colBand', ...clampBand(target.c, COL_BAND_HALF, GRID.cols) };
      default:
        return { kind: 'parity', parity: (target.r + target.c) % 2 === 0 ? 'even' : 'odd' };
    }
  }

  // Tier 3: a tight box. Sharp, and only ever a coin flip away from a lie.
  // Both radii are derived from the grid so the box stays the same *share* of
  // the map at any size — see the geometry note in types.ts.
  return {
    kind: 'distance',
    r: target.r,
    c: target.c,
    within: RING_RADII[shapeRoll % RING_RADII.length]!,
  };
}

/**
 * The full hint set for a hunt. Pure — call it as often as you like.
 *
 * `isTrue` on the result is the *intent*; the payload is then checked against the
 * real cell so the stored flag always reflects what the hint actually says. They
 * can differ legitimately: a decoy two rows away still falls inside a five-row
 * band, so a hint generated as a lie can land on the truth by accident. Recording
 * what is rather than what was intended keeps phase 2's audit honest.
 */
export function hintsForHunt(hunt: Hunt): HintRecord[] {
  const real = { r: hunt.r, c: hunt.c };
  const out: HintRecord[] = [];

  for (let idx = 0; idx < HINTS_PER_HUNT; idx++) {
    const tier = tierFor(hunt.salt, hunt.id, idx);
    const intended = truthFor(hunt.salt, hunt.id, idx, tier);
    const payload = payloadFor(hunt.salt, hunt.id, idx, tier, intended, real);

    out.push({
      id: `${hunt.id}:${idx}`,
      huntId: hunt.id,
      zoneId: hunt.zoneId,
      epoch: hunt.epoch,
      idx,
      tier,
      reliabilityBps: TIER_RELIABILITY_BPS[tier],
      payload,
      // What the hint actually asserts, not what we meant it to.
      isTrue: cellMatches(payload, real.r, real.c),
      expiresAt: hunt.expiresAt,
    });
  }

  return out;
}

/**
 * Whether revealing this cell earns a hint, and which one.
 *
 * Keyed on the cell and the player, so neither can be re-rolled: the outcome
 * was fixed by the zone salt long before either was known.
 *
 * Split into two questions because a clue tile answers the first one for you.
 * It still has to ask the second, so that a guaranteed hint is a *certain* hint
 * rather than a *better* one — otherwise "clue" would quietly be a tier
 * upgrade as well as a drop upgrade.
 */
export const HINT_DROP_PCT = 35;

/** Does this cell pay a hint at all? */
export function hintDrops(salt: string, playerId: string, r: number, c: number): boolean {
  return hashInt(salt, playerId, r, c, 'drop') % 100 < HINT_DROP_PCT;
}

/** Which member of a pool, once something has decided that a hint is owed. */
export function hintIndex(
  salt: string,
  playerId: string,
  r: number,
  c: number,
  poolSize: number,
): number | null {
  if (poolSize <= 0) return null;
  return hashInt(salt, playerId, r, c, 'which') % poolSize;
}

/**
 * The original combined form: rolls for a drop, then picks. Kept because it is
 * the honest description of an ordinary dig, which is still most of them.
 */
export function hintDrop(
  salt: string,
  playerId: string,
  r: number,
  c: number,
  poolSize: number,
): number | null {
  if (!hintDrops(salt, playerId, r, c)) return null;
  return hintIndex(salt, playerId, r, c, poolSize);
}

export { MID_ROW, MID_COL };
