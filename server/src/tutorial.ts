import { GRID, TUTORIAL } from './config';
import { tx } from './db/index';
import * as huntRepo from './db/repos/hunts';
import * as director from './director';
import { hash, hashInt, randomHex } from './hash';
import * as hints from './hints';
import { cellKey, tileType } from './grid';
import { logger } from './logger';
import * as store from './store';
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
 * Eight steps, each one existing to make a word mean something. Everything is
 * taught by doing it once on a real board — there is no sandbox, no fake grid,
 * and nothing here that behaves differently from the game it is teaching.
 *
 *   1. **Dig.** A clue tile, guaranteed, so the first tap always pays. The
 *      lesson is that the labels on this board are real — which is the lesson
 *      the old first tap taught in reverse, by landing on a "trap" that did
 *      nothing. Says what a dig costs while the bar is visibly moving.
 *   2. **The hint you just earned.** Where hints live, and that we publish how
 *      often each one lies. A player who never opens the drawer never plays
 *      the game we built.
 *   3. **Survey.** The onboarding has promised warmth since phase 0 about a
 *      mechanic that did not exist until phase 3. This is where the promise is
 *      kept, and it reads `burning`, because the treasure is right there.
 *   4. **The reading.** What five bands mean and how to walk them. This is the
 *      only step that teaches a *strategy* rather than a control.
 *   5. **Dig the treasure.** Hint and reading agree; the player acts on both.
 *   6. **Energy.** Taught at the first moment the player has spent enough to
 *      care: what the bar is, how fast it comes back, that it is the only thing
 *      we sell, and that it never buys a chance at a prize.
 *   7. **The race**, explained *before* it starts. It ran second at first, on
 *      the reasoning that an explanation belongs beside the thing it explains —
 *      which put a four-line paragraph in front of a player with a live
 *      fifteen-second clock behind it. The first scripted run of the
 *      walkthrough timed out reading its own last card. An explanation racing a
 *      countdown is not an explanation.
 *   8. **Enter.** Keys are taught here because this is the only moment the word
 *      means anything, and the walkthrough ends by handing over the controls
 *      rather than by talking over them.
 *
 * ─────────────────────────── why the position is stored ─────────────────────
 *
 * The first version derived its position from the map — step 1 done once the
 * start cell was open, everything after that step 3 — which made the Survey
 * step unreachable, because a survey leaves no mark to derive anything from.
 * Half the steps above teach things that are invisible on the board, so the
 * position lives on the player. See migration 020.
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
    // An owned hunt is scoped by `ownerId`, never by the public clock — it is
    // placed for one player and is already visible to them. Immediately public
    // keeps it out of the discovery path entirely rather than giving the
    // tutorial a head start over a field that does not exist.
    publicAt: now,
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

/** Which HUD element the coach mark should point at, if any. */
export type TutorialHighlight = 'energy' | 'keys' | 'hints' | 'survey' | null;

export interface TutorialStep {
  /** Stable key, so the client can special-case a step without index maths. */
  id: string;
  /**
   * What finishes this step.
   *
   * `read` is the odd one out and is deliberate: four of the eight steps teach
   * something that has no tap — what a hint is, what a band means, what energy
   * is, what a key is. Those advance on acknowledgement. A walkthrough that can
   * only teach controls can only teach half a game.
   */
  action: 'dig' | 'survey' | 'enter' | 'read';
  /** Where to point on the map. Null for steps that are about the HUD. */
  r: number | null;
  c: number | null;
  title: string;
  copy: string;
  highlight: TutorialHighlight;
}

export interface TutorialState {
  step: TutorialStep | null;
  index: number;
  total: number;
  huntId: string | null;
  done: boolean;
}

/**
 * The script.
 *
 * Written as a function of the two cells it points at rather than as a
 * constant, because every step that has a target needs one of them and neither
 * is known until a player and a zone exist.
 *
 * ─────────────────────────── the rules these were written to ────────────────
 *
 * The same three that govern the onboarding cards, plus one more that only
 * applies once someone is holding the controls:
 *
 *   * No crypto vocabulary.
 *   * No promise the game cannot keep in the next sixty seconds.
 *   * Say what the player will DO, not what the system is.
 *   * **Never describe a cost the player is not about to pay.** Energy is
 *     taught at step 6, not step 1, because that is the first moment the bar
 *     has moved enough to be worth looking at. A number explained before it
 *     matters is a number nobody reads.
 */
function scriptFor(start: { r: number; c: number }, hunt: Hunt): TutorialStep[] {
  return [
    {
      id: 'dig',
      action: 'dig',
      r: start.r,
      c: start.c,
      title: 'DIG THIS TILE',
      copy: 'Tap it. Digging uncovers what is underneath and costs 2 energy. This one is a CLUE tile, and a clue always pays a hint.',
      highlight: 'energy',
    },
    {
      id: 'hint',
      action: 'read',
      r: null,
      c: null,
      title: 'THAT IS A HINT',
      copy: 'It says roughly where treasure is. Every hint carries how often that kind turns out to be TRUE — 90%, 70% or 50%. We publish it because some of them lie. Your hints live in the drawer at the bottom.',
      highlight: 'hints',
    },
    {
      id: 'survey',
      action: 'survey',
      r: start.r + 1,
      c: start.c,
      title: 'NOW SURVEY',
      copy: 'The toggle at the top has switched to SURVEY 6⚡ for you. Tap the marked tile to read it: surveying uncovers nothing and costs 6 energy, and it tells you how close the nearest treasure is. It is the thinking move.',
      highlight: 'survey',
    },
    {
      id: 'reading',
      action: 'read',
      r: null,
      c: null,
      title: 'WHAT THAT READING MEANS',
      copy: 'That is how far the nearest treasure is from the tile you just surveyed — not what is under it. One reading only narrows things a little. Survey again ten or twenty tiles away and compare: wherever the readings run hottest is where to start digging.',
      highlight: null,
    },
    {
      id: 'find',
      action: 'dig',
      r: hunt.r,
      c: hunt.c,
      title: 'YOUR HINT AND YOUR READING AGREE',
      copy: 'Both of them point here. You are back on DIG 2⚡ — tap the marked tile and take a look.',
      highlight: null,
    },
    {
      id: 'energy',
      action: 'read',
      r: null,
      c: null,
      title: 'ABOUT THAT BAR',
      copy: 'Energy is what limits you: 40 of it, and one point back every 6 minutes. It is the only thing we sell — it buys you more looking, never a better chance at the prize.',
      highlight: 'energy',
    },
    {
      id: 'race',
      action: 'read',
      r: null,
      c: null,
      title: 'HOW YOU WIN IT',
      copy: 'Six doors, and everyone racing sees the same six. Your hints rule doors out. Everyone picks inside fifteen seconds and all the picks turn over together — so nothing is decided by how fast your phone is or how good your signal is.',
      highlight: null,
    },
    {
      id: 'enter',
      action: 'enter',
      r: hunt.r,
      c: hunt.c,
      title: 'NOW GO AND TAKE IT',
      copy: 'A cash treasure costs one KEY to enter. You get 5 keys a day, everyone gets the same 5, and there is no way to buy more — not with money, not with anything. This one pays XP, so it is free. Open it, and pick a door.',
      highlight: 'keys',
    },
  ];
}

/** How many steps there are. Exported so the funnel can ask "how far did they get". */
export const TUTORIAL_STEPS = 8;

export function stateFor(
  player: Player,
  zone: Zone,
  now = Date.now(),
): TutorialState {
  const index = player.tutorialStep;
  if (index >= TUTORIAL_STEPS) {
    return { step: null, index: TUTORIAL_STEPS, total: TUTORIAL_STEPS, huntId: null, done: true };
  }

  const hunt = ensureHunt(player, zone, now);
  // No hunt to lead to — either the cell was taken or the player has already
  // won it. Either way there is nothing left to teach, and a coach mark
  // pointing at a treasure that is not there is worse than no coach mark.
  if (!hunt) {
    return { step: null, index, total: TUTORIAL_STEPS, huntId: null, done: false };
  }

  const script = scriptFor(startCell(player, zone), hunt);
  return {
    step: script[index] ?? null,
    index,
    total: TUTORIAL_STEPS,
    huntId: hunt.id,
    done: false,
  };
}

/**
 * What the player just did.
 *
 * `dig` carries the cell so a dig somewhere else does not advance a step that
 * is pointing at a particular tile — otherwise the walkthrough would march on
 * while the player wandered, and the coach marks would end up describing
 * actions they never took.
 */
export type TutorialEvent =
  | { kind: 'dig'; r: number; c: number }
  | { kind: 'survey' }
  | { kind: 'enter' }
  | { kind: 'ack' };

/**
 * Move the walkthrough on, if this event is the one the current step is waiting
 * for.
 *
 * Called from the routes that already do the thing — not from a client that
 * reports having done it. A walkthrough the client can advance on its own is a
 * walkthrough that can be skipped by accident and cannot be trusted as a funnel
 * measurement.
 */
export function advance(player: Player, zone: Zone, event: TutorialEvent, now = Date.now()): void {
  const state = stateFor(player, zone, now);
  const step = state.step;
  if (!step) return;

  const matches =
    (step.action === 'dig' && event.kind === 'dig' && step.r === event.r && step.c === event.c) ||
    (step.action === 'survey' && event.kind === 'survey') ||
    (step.action === 'enter' && event.kind === 'enter') ||
    (step.action === 'read' && event.kind === 'ack');

  if (matches) store.setTutorialStep(player, state.index + 1);
}

/**
 * Is this the walkthrough's very first dig?
 *
 * Used to guarantee that first hint is a true one. See the note at the call
 * site in http.ts — a lie handed to a player who holds nothing to check it
 * against teaches the wrong lesson on the one hunt they cannot lose.
 */
export function isFirstStepCell(player: Player, zone: Zone, r: number, c: number): boolean {
  if (player.tutorialStep !== 0) return false;
  const start = startCell(player, zone);
  return start.r === r && start.c === c;
}

export const isClue = (zone: Zone, r: number, c: number): boolean =>
  tileType(zone, r, c) === 'clue';
