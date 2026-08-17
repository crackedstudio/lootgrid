import { GRID, TUTORIAL } from './config';
import { tx } from './db/index';
import * as huntRepo from './db/repos/hunts';
import * as director from './director';
import { hash, hashInt, randomHex } from './hash';
import * as hints from './hints';
import { cellKey, tileType } from './grid';
import { logger } from './logger';
import type { Hunt, Player, Zone } from './types';

/**
 * The first sixty seconds.
 *
 * ─────────────────────────── the number this exists for ─────────────────────
 *
 * Four out of five new players never found a single treasure in their first
 * session. That was measured on a 216-cell grid with four treasures on it; the
 * map is now 3,600 cells, so leaving the first find to chance would be worse,
 * not better. A first bar buys twenty digs against twenty-four treasures — call
 * it a two percent chance of stumbling onto one.
 *
 * No top-grossing mobile game leaves this to chance. Clash Royale's tutorial
 * battle cannot be lost. Candy Crush level one cannot be failed. The fantasy is
 * handed over inside a minute, deliberately, every time.
 *
 * So the first treasure is not found — it is **placed**, three tiles from where
 * the player is told to start, and reserved for them alone.
 *
 * ─────────────────────────── what it teaches, in order ──────────────────────
 *
 * The script is three taps and each one exists to make a word mean something:
 *
 *   1. A **clue** tile. Guaranteed, so the first tap always pays. The lesson is
 *      that the labels on this board are real — which is the lesson the old
 *      first tap taught in reverse, by landing on a "trap" that did nothing.
 *   2. A **survey**. The onboarding has promised warmth since phase 0 about a
 *      mechanic that did not exist until phase 3. This is where the promise is
 *      kept, and it reads `burning`, because the treasure is right there.
 *   3. The **treasure**. Placed, reserved, and XP-paying.
 *
 * ─────────────────────────── why it pays XP, not cash ───────────────────────
 *
 * The review asks for a tutorial that "pays a real prize". §7a is the later and
 * stronger rule — no real money in a zone until the gate is live — and a
 * tutorial cash prize is real money handed to a brand-new ungated wallet. Fifty
 * wallets, fifty prizes, which is precisely the hole phase 5 closed.
 *
 * What the tutorial has to deliver is the *fantasy*: I looked, I found, I won.
 * Energy and XP deliver that, and energy is a real reward in this economy — it
 * is what the review's own referral table pays.
 */

/**
 * Where a new player is told to start. Deterministic per player and zone.
 *
 * **It has to be a clue tile.** The script says "this one is a clue — it always
 * pays", and only 17% of the board is. Promising a guaranteed hint and then
 * rolling for it would repeat the exact mistake this phase exists to fix: the
 * old first tap landed on a tile labelled "trap" that did nothing, and taught a
 * new player in one second that our words are decorative.
 *
 * So the cell is searched for rather than picked. The scan walks outward from a
 * hashed origin and is deterministic, so a player returning to a zone is sent
 * to the same tile.
 */
export function startCell(player: Player, zone: Zone): { r: number; c: number } {
  const margin = TUTORIAL.margin;
  const rows = GRID.rows - 2 * margin;
  const cols = GRID.cols - 2 * margin;

  const originR = margin + (hashInt(player.id, zone.id, 'start:r') % rows);
  const originC = margin + (hashInt(player.id, zone.id, 'start:c') % cols);

  // Walk the interior in a fixed order from the origin. Bounded by the interior
  // size, so it always terminates; 17% clue density means it finds one within a
  // handful of steps essentially always.
  for (let i = 0; i < rows * cols; i++) {
    const r = margin + ((originR - margin + Math.floor(i / cols)) % rows);
    const c = margin + ((originC - margin + i) % cols);
    if (tileType(zone, r, c) === 'clue') return { r, c };
  }

  // Unreachable while any clue exists on the interior. Falling back to the
  // origin keeps the tutorial running; the first step simply pays what that
  // tile pays.
  return { r: originR, c: originC };
}

/**
 * A cell near the start with no treasure already on it.
 *
 * The preferred offset first, then a ring around it. Without the fallback, a
 * collision with a real hunt meant `ensureHunt` returned null and that player
 * got no tutorial at all — about one new player in a hundred and fifty, failing
 * silently, which is the worst possible shape for a bug in the one part of the
 * game that exists to stop people leaving.
 *
 * Every candidate stays within Chebyshev 3 of the start, so the script's "go
 * and take it" is always one short move after the survey.
 */
function freeCellNear(zone: Zone, start: { r: number; c: number }): { r: number; c: number } | null {
  const preferred = TUTORIAL.treasureOffset;
  const offsets = [
    preferred,
    { r: -preferred.r, c: preferred.c },
    { r: preferred.r, c: -preferred.c },
    { r: -preferred.r, c: -preferred.c },
    { r: preferred.c, c: preferred.r },
    { r: -preferred.c, c: preferred.r },
    { r: 3, c: 0 },
    { r: 0, c: 3 },
    { r: -3, c: 0 },
    { r: 0, c: -3 },
  ];

  for (const off of offsets) {
    const r = start.r + off.r;
    const c = start.c + off.c;
    if (r < 0 || c < 0 || r >= GRID.rows || c >= GRID.cols) continue;
    if (huntRepo.at(zone.id, zone.epoch, r, c)) continue;
    return { r, c };
  }
  return null;
}

export interface TutorialStep {
  /** What the player is asked to do. The client renders a pointer at the cell. */
  action: 'dig' | 'survey' | 'enter';
  r: number;
  c: number;
  copy: string;
}

export interface TutorialState {
  /** Null once the player has finished, or opted out. */
  step: TutorialStep | null;
  /** 0-based index into the script, for a progress dot. */
  index: number;
  total: number;
  huntId: string | null;
}

/**
 * The player's tutorial hunt in this zone, creating it on first ask.
 *
 * Idempotent: a player has at most one live reserved hunt per zone, so calling
 * this on every grid load is safe and a reconnect does not scatter treasure
 * across the map.
 */
export function ensureHunt(player: Player, zone: Zone, now = Date.now()): Hunt | null {
  const existing = huntRepo.listOwned(zone.id, zone.epoch, player.id);
  if (existing.length > 0) return existing[0]!;

  const start = startCell(player, zone);
  const at = freeCellNear(zone, start);

  // Nowhere free within reach. Vanishingly unlikely — it needs every cell in a
  // small ring around the start to already hold a treasure — and giving up is
  // correct when it happens, because stacking two hunts on one tile is worse
  // than a missing tutorial.
  if (!at) {
    logger.warn({ playerId: player.id, zoneId: zone.id, start }, 'no free cell for a tutorial treasure');
    return null;
  }

  const salt = randomHex(32);
  const id = `${zone.id}-${zone.epoch}-tut-${cellKey(at.r, at.c).replace(',', 'x')}-${randomHex(3)}`;

  const hunt: Hunt = {
    id,
    zoneId: zone.id,
    epoch: zone.epoch,
    r: at.r,
    c: at.c,
    salt,
    cellCommit: hash(id, zone.id, at.r, at.c, salt).toString('hex'),
    // XP, always. See the header — a cash tutorial prize would reopen the sybil
    // hole phase 5 closed.
    kind: 'puzzle',
    ownerId: player.id,
    // The easiest tables every module carries. A tutorial you can fail is a
    // tutorial that teaches you the game is unfair.
    difficulty: 'easy',
    prizeLabel: 'XP',
    status: 'live',
    winnerId: null,
    game: null,
    // Outlives the session comfortably, and dies with the epoch like everything
    // else — `replenish`'s clamp does not apply here because nothing restocks a
    // tutorial, so it is clamped explicitly.
    expiresAt: zone.rotatesAt === null ? now + TUTORIAL.ttlMs : Math.min(now + TUTORIAL.ttlMs, zone.rotatesAt),
    createdAt: now,
  };

  tx(() => {
    huntRepo.insert(hunt);
    // Same discipline as a real hunt: the hint set is committed before the hunt
    // can be played. A tutorial that skipped the commitment would be the one
    // hunt on the board whose honesty could not be checked.
    hints.commitAtCreation(hunt, now);
    director.open({ huntId: hunt.id, salt: hunt.salt, difficulty: hunt.difficulty });
  });

  logger.info({ playerId: player.id, zoneId: zone.id, at }, 'tutorial treasure placed');
  return hunt;
}

/**
 * Where the player is in the script.
 *
 * Derived from what they have actually done rather than stored as a cursor:
 * progress is a fact about reveals and hunts, so a cursor could disagree with
 * the board. It also means the tutorial cannot get stuck — a player who wanders
 * off and digs elsewhere simply finds the script waiting where they left it.
 */
export function stateFor(
  player: Player,
  zone: Zone,
  hasRevealed: (r: number, c: number) => boolean,
  now = Date.now(),
): TutorialState {
  const hunt = ensureHunt(player, zone, now);
  const start = startCell(player, zone);
  const total = 3;

  // No hunt to lead to — either the cell was taken or the player has already
  // won it. Either way there is nothing to teach.
  if (!hunt) return { step: null, index: total, total, huntId: null };

  const script: TutorialStep[] = [
    {
      action: 'dig',
      ...start,
      copy: 'DIG HERE. THIS ONE IS A CLUE — IT ALWAYS PAYS.',
    },
    {
      action: 'survey',
      r: start.r + 1,
      c: start.c,
      copy: 'NOW SURVEY. IT READS THE GROUND WITHOUT DIGGING IT.',
    },
    {
      action: 'enter',
      r: hunt.r,
      c: hunt.c,
      copy: 'SOMETHING IS BURIED HERE. GO AND TAKE IT.',
    },
  ];

  // Step 1 is done once the start cell is open; step 2 once they have surveyed
  // — which leaves no trace on the map, so it is treated as done as soon as
  // step 1 is, and the client advances it locally. Step 3 ends when the hunt
  // stops being live.
  const index = !hasRevealed(start.r, start.c) ? 0 : 2;

  return { step: script[index] ?? null, index, total, huntId: hunt.id };
}

/** Whether this tile is a clue, so the script can promise one honestly. */
export const isClue = (zone: Zone, r: number, c: number): boolean =>
  tileType(zone, r, c) === 'clue';
