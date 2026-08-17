import { SURVEY } from './config';
import type { Hunt } from './types';

/**
 * Survey: how close is the nearest treasure?
 *
 * Lifted from `games/search.ts` with the evader removed. That module answers
 * the same question about a target that runs when you look at it; a treasure
 * sits still, so what is left is the reading itself — Chebyshev distance,
 * because a square ring reads naturally on a grid and matches how the hint
 * system's `distance` payload already works.
 *
 * ─────────────────────────── what it must not return ────────────────────────
 *
 * A number. `bandFor` exists so that the exact distance never leaves this
 * module: two precise readings and some arithmetic would pin a treasure
 * exactly, and the map would stop being worth exploring. The band is the whole
 * design — see the SURVEY block in config.ts.
 *
 * It also must not say *which* treasure it found. On a 24-treasure map,
 * naming the target would let a player separate the readings per hunt and
 * triangulate each one independently, which is a much easier problem than the
 * one intended: "something is near here".
 *
 * ─────────────────────────── it is a LOCAL instrument ───────────────────────
 *
 * Worth stating plainly, because the obvious reading of "three surveys
 * triangulate a location" is wrong on this map and the mistake is invisible.
 *
 * Each reading reports the *nearest* treasure to where it was taken. With
 * twenty-four of them on the grid, two readings taken far apart are almost
 * certainly describing two different treasures, and intersecting them yields
 * nothing — not a narrower answer, an empty one. Triangulation works inside a
 * neighbourhood, where the readings share a nearest treasure, and that is the
 * intended loop: survey wide to find a warm region, then survey tightly within
 * it to pin what is there.
 *
 * This is a property of treasure density rather than of the detector. If
 * `CASH_PER_ZONE` or `HUNTS_PER_ZONE` move a long way, re-check it — a sparse
 * map makes Survey global and a much stronger instrument than these bands were
 * chosen for.
 */

export type SurveyBand = (typeof SURVEY.bands)[number]['name'] | typeof SURVEY.coldest;

export interface SurveyReading {
  r: number;
  c: number;
  band: SurveyBand;
  /** How many bands there are, so a client can draw a scale without guessing. */
  scale: number;
  at: number;
}

/** Chebyshev distance — the same metric the `distance` hint payload uses. */
export const distanceTo = (hunt: Hunt, r: number, c: number): number =>
  Math.max(Math.abs(hunt.r - r), Math.abs(hunt.c - c));

/** The coarse name for a distance. Never the distance itself. */
export function bandFor(distance: number): SurveyBand {
  for (const band of SURVEY.bands) {
    if (distance <= band.within) return band.name;
  }
  return SURVEY.coldest;
}

/**
 * Read the grid from a cell.
 *
 * Returns null when the zone holds no live treasure at all, which is a state
 * `replenish` works to prevent — a reading of "cold" would be a lie in that
 * case, since it implies something is out there.
 *
 * Every live hunt counts, cash and puzzle alike. A detector that only found
 * funded treasure would leak which of the twenty-four carry money, and that is
 * exactly the information the difficulty and prize labels are meant to disclose
 * openly rather than through a side channel.
 */
export function read(liveHunts: Hunt[], r: number, c: number, now = Date.now()): SurveyReading | null {
  if (liveHunts.length === 0) return null;

  let nearest = Infinity;
  for (const hunt of liveHunts) {
    const d = distanceTo(hunt, r, c);
    if (d < nearest) nearest = d;
  }

  return {
    r,
    c,
    band: bandFor(nearest),
    scale: SURVEY.bands.length + 1,
    at: now,
  };
}
