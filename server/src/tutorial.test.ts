import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as admission from './admission';
import type { App } from './appTypes';
import { GRID, TUTORIAL } from './config';
import { tileType } from './grid';
import { registerRoutes } from './http';
import * as hints from './hints';
import * as referee from './referee';
import * as store from './store';
import * as tutorial from './tutorial';
import { freshWorld, makePlayer, teardownWorld } from './testing/harness';

/**
 * The first sixty seconds.
 *
 * Four out of five new players never found a single treasure in their first
 * session, and the map is now seventeen times larger than when that was
 * measured. Every assertion here is about the same promise: a new player finds
 * treasure quickly, cannot lose it, and learns that the words on the board mean
 * what they say.
 */

const NEWBIE = '0x00000000000000000000000000000000000000f1';
const STRANGER = '0x00000000000000000000000000000000000000f2';

let app: App;

beforeEach(async () => {
  freshWorld();
  app = Fastify({ logger: false }) as unknown as App;
  registerRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  referee.stop();
  teardownWorld();
});

const gridFor = (who: string) =>
  app
    .inject({ method: 'GET', url: '/zones/ridge/grid', headers: { 'x-player': who } })
    .then(r => r.json());

const post = (who: string, url: string) =>
  app.inject({ method: 'POST', url, headers: { 'x-player': who } });

const dig = (who: string, r: number, c: number) =>
  post(who, `/zones/ridge/tiles/${r}/${c}/open`);
const survey = (who: string, r: number, c: number) =>
  post(who, `/zones/ridge/survey/${r}/${c}`);
const enter = (who: string, huntId: string) => post(who, `/hunts/${huntId}/attempts`);
const ack = (who: string) => post(who, '/zones/ridge/tutorial/ack');

describe('the treasure is placed, not found', () => {
  it('reserves one within reach of where the player is told to start', async () => {
    const g = await gridFor(NEWBIE);
    const mine = g.hunts.filter((h: { ownerId: string | null }) => h.ownerId === NEWBIE);

    expect(mine).toHaveLength(1);
    const step = g.tutorial.step;
    const distance = Math.max(Math.abs(mine[0].r - step.r), Math.abs(mine[0].c - step.c));
    // Close enough to reach after one survey. Leaving the first find to chance
    // is a two-percent proposition on this map.
    expect(distance).toBeLessThanOrEqual(3);
  });

  it('pays XP, never cash', async () => {
    // The review asks for a tutorial that "pays a real prize"; §7a is the later
    // and stronger rule. A cash prize handed to a brand-new ungated wallet is
    // fifty wallets and fifty prizes — the hole phase 5 closed.
    const g = await gridFor(NEWBIE);
    const mine = g.hunts.find((h: { ownerId: string | null }) => h.ownerId === NEWBIE);
    expect(mine.kind).toBe('puzzle');
    expect(mine.prizeLabel).toBe('XP');
  });

  it('is set to the easiest tables, so it cannot be lost on difficulty', () => {
    const zone = store.getZone('ridge')!;
    const hunt = tutorial.ensureHunt(makePlayer(NEWBIE), zone)!;
    expect(hunt.difficulty).toBe('easy');
  });

  it('plays The Crack, even though it is a puzzle hunt', () => {
    // This assertion is the reverse of what it used to be, and the reversal is
    // deliberate.
    //
    // The old rule was "never The Crack — a tutorial must not teach a mechanic
    // the player is two days away from being allowed to use." The cost of that
    // rule is larger than the thing it was protecting against: a puzzle hunt
    // draws one of the four reflex games, which have decided nothing since
    // phase 4, so the walkthrough spent its one guaranteed find teaching a
    // tapping race that never comes back — immediately after teaching hints,
    // which it then never connected to anything.
    //
    // The Crack is where hints become the win. Showing it once, on an XP hunt,
    // is also the clearest possible statement of what the two-day wait is FOR.
    // A player who has seen the doors knows what they are waiting for; one who
    // has not is just waiting.
    const zone = store.getZone('ridge')!;
    const hunt = tutorial.ensureHunt(makePlayer(NEWBIE), zone)!;
    expect(store.blockGame(hunt).type).toBe('crack');
  });

  it('hands out a TRUE hint on the first dig', async () => {
    // Found on the first end-to-end run: the tutorial's hint was a SHARP one,
    // the tier roll made it false, and at The Crack all six doors read RULED
    // OUT. The one hunt a new player cannot lose demonstrated deduction
    // failing, with nothing else in their inventory to check it against.
    await gridFor(NEWBIE);
    const zone = store.getZone('ridge')!;
    const start = tutorial.startCell(makePlayer(NEWBIE), zone);
    const res = await app.inject({
      method: 'POST',
      url: `/zones/ridge/tiles/${start.r}/${start.c}/open`,
      headers: { 'x-player': NEWBIE },
    });
    const hint = res.json().hint;
    expect(hint).toBeTruthy();

    // The published honesty numbers are untouched: the hint comes from the
    // hunt's already-committed set, so this chose one rather than inventing it.
    const set = store.getHunt(hint.huntId) ? hints.forHunt(store.getHunt(hint.huntId)!) : [];
    expect(set.find(h => h.id === hint.id)?.isTrue).toBe(true);
  });

  it('commits its hint set like any other hunt', () => {
    // The one hunt on the board whose honesty could not be checked would be a
    // strange thing to hand a new player.
    const zone = store.getZone('ridge')!;
    const hunt = tutorial.ensureHunt(makePlayer(NEWBIE), zone)!;
    expect(store.getHunt(hunt.id)).toBeDefined();
    expect(hunt.cellCommit).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('it belongs to one player', () => {
  it('is invisible on everyone else’s map', async () => {
    await gridFor(NEWBIE);
    const theirs = await gridFor(STRANGER);
    expect(theirs.hunts.some((h: { ownerId: string | null }) => h.ownerId === NEWBIE)).toBe(false);
  });

  it('refuses an entry from anyone else', () => {
    const zone = store.getZone('ridge')!;
    const hunt = tutorial.ensureHunt(makePlayer(NEWBIE), zone)!;
    const stranger = makePlayer(STRANGER);

    expect(admission.mayEnter(stranger, hunt)).toMatchObject({
      ok: false,
      code: 'not_your_hunt',
    });
    expect(admission.mayEnter(makePlayer(NEWBIE), hunt).ok).toBe(true);
  });

  it('does not displace a real treasure', () => {
    // Owned hunts sit outside the shared map's count, so placing one must not
    // consume one of the zone's HUNTS_PER_ZONE slots.
    const zone = store.getZone('ridge')!;
    const before = store.liveHuntsIn(zone).length;
    tutorial.ensureHunt(makePlayer(NEWBIE), zone);
    expect(store.liveHuntsIn(zone).length).toBe(before);
  });

  it('places at most one, however often it is asked', () => {
    const zone = store.getZone('ridge')!;
    const player = makePlayer(NEWBIE);
    const first = tutorial.ensureHunt(player, zone)!;
    for (let i = 0; i < 5; i++) expect(tutorial.ensureHunt(player, zone)!.id).toBe(first.id);
    expect(store.ownedHuntsIn(zone, NEWBIE)).toHaveLength(1);
  });
});

describe('the script only promises what the board delivers', () => {
  /**
   * The lesson the old first tap taught, in reverse.
   *
   * A new player's first tile used to be labelled "trap" and do nothing, which
   * taught in one second that the words here are decorative. Step one says the
   * tile is a clue, so the tile has to be a clue — only 17% of the board is.
   */
  it('starts every player on an actual clue tile', () => {
    const zone = store.getZone('ridge')!;
    for (let i = 0; i < 40; i++) {
      const player = makePlayer(`0xstart${i}`);
      const start = tutorial.startCell(player, zone);
      expect(tileType(zone, start.r, start.c), `${start.r},${start.c}`).toBe('clue');
    }
  });

  it('keeps the start away from the edges', () => {
    const zone = store.getZone('ridge')!;
    for (let i = 0; i < 40; i++) {
      const start = tutorial.startCell(makePlayer(`0xedge${i}`), zone);
      expect(start.r).toBeGreaterThanOrEqual(TUTORIAL.margin);
      expect(start.c).toBeGreaterThanOrEqual(TUTORIAL.margin);
      expect(start.r).toBeLessThan(GRID.rows - TUTORIAL.margin);
      expect(start.c).toBeLessThan(GRID.cols - TUTORIAL.margin);
    }
  });

  it('sends the same player to the same tile every time', () => {
    // A script that moves between sessions is not a script.
    const zone = store.getZone('ridge')!;
    const player = makePlayer(NEWBIE);
    const a = tutorial.startCell(player, zone);
    expect(tutorial.startCell(player, zone)).toEqual(a);
  });

  it('advances once the first tile is dug', async () => {
    const before = (await gridFor(NEWBIE)).tutorial;
    expect(before.index).toBe(0);
    expect(before.step.action).toBe('dig');

    await dig(NEWBIE, before.step.r, before.step.c);

    const after = (await gridFor(NEWBIE)).tutorial;
    expect(after.index).toBe(1);
    // The hint the dig just paid, which is the step that used to be skipped.
    expect(after.step.id).toBe('hint');
  });

  it('does not advance on a dig somewhere else', async () => {
    // Otherwise the script marches on while the player wanders, and every coach
    // mark after that describes an action they never took.
    const before = (await gridFor(NEWBIE)).tutorial;
    await dig(NEWBIE, (before.step.r + 20) % 60, (before.step.c + 20) % 60);
    expect((await gridFor(NEWBIE)).tutorial.index).toBe(before.index);
  });

  it('reaches every step, and the survey step is one of them', async () => {
    // The bug this is here for: the old position was derived from the map with
    // `!hasRevealed(start) ? 0 : 2`, an expression that cannot return 1. The
    // Survey step — the mechanic the whole game is built on — was unreachable
    // from the day it was written, and no test noticed because none of them
    // asked for the whole sequence.
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = (await gridFor(NEWBIE)).tutorial;
      if (!t.step) break;
      seen.push(t.step.id);

      if (t.step.action === 'dig') await dig(NEWBIE, t.step.r, t.step.c);
      else if (t.step.action === 'survey') await survey(NEWBIE, t.step.r, t.step.c);
      else if (t.step.action === 'enter') await enter(NEWBIE, t.huntId);
      else await ack(NEWBIE);
    }

    expect(seen).toEqual([
      // `race` before `enter`, and the order is load-bearing. It ran the other
      // way first, on the reasoning that an explanation belongs beside the thing
      // it explains — which put a four-line paragraph in front of a player with
      // The Crack's fifteen-second clock already running behind it. The first
      // scripted run of the walkthrough timed out reading its own last card.
      'dig', 'hint', 'survey', 'reading', 'find', 'energy', 'race', 'enter',
    ]);
    expect((await gridFor(NEWBIE)).tutorial.done).toBe(true);
  });

  it('points the find step at the placed treasure', async () => {
    const g = await gridFor(NEWBIE);
    await dig(NEWBIE, g.tutorial.step.r, g.tutorial.step.c);
    await ack(NEWBIE);
    const t = (await gridFor(NEWBIE)).tutorial;
    await survey(NEWBIE, t.step.r, t.step.c);
    await ack(NEWBIE);

    const after = (await gridFor(NEWBIE)).tutorial;
    const hunt = store.getHunt(after.huntId)!;
    expect(after.step.id).toBe('find');
    expect({ r: after.step.r, c: after.step.c }).toEqual({ r: hunt.r, c: hunt.c });
  });

  it('lets you dig your own reserved treasure instead of 409ing', async () => {
    // The walkthrough says "both of them point here, dig it". Before this, that
    // tap answered `is_hunt` — "open this one from the hunt sheet" — because the
    // handler only treated an UNOWNED treasure as a find. An instruction that
    // errors is worse than no instruction.
    const zone = store.getZone('ridge')!;
    const hunt = tutorial.ensureHunt(makePlayer(NEWBIE), zone)!;
    const res = await dig(NEWBIE, hunt.r, hunt.c);
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
  });

  it('an ack cannot skip a step that needs a real action', async () => {
    // The client says THAT it acknowledged; the server decides whether the
    // current step was one that could be. Otherwise a replayed ack walks
    // straight past the digging.
    const before = (await gridFor(NEWBIE)).tutorial;
    expect(before.step.action).toBe('dig');
    await ack(NEWBIE);
    await ack(NEWBIE);
    expect((await gridFor(NEWBIE)).tutorial.index).toBe(before.index);
  });
});

describe('the empty bar says something', () => {
  it('reports warmth and a wait rather than nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/zones/ridge/stuck',
      headers: { 'x-player': NEWBIE },
    });

    const body = res.json();
    expect(res.statusCode).toBe(200);
    // A reason to come back, and a time to come back.
    expect(body.nearest.band).toBeTruthy();
    expect(typeof body.msUntilPlayable).toBe('number');
  });

  it('costs no energy to ask', async () => {
    // Charging six energy for a warmth reading to a player who has none would
    // be a joke at their expense.
    const before = (await app.inject({ method: 'GET', url: '/me', headers: { 'x-player': NEWBIE } })).json();
    await app.inject({ method: 'GET', url: '/zones/ridge/stuck', headers: { 'x-player': NEWBIE } });
    const after = (await app.inject({ method: 'GET', url: '/me', headers: { 'x-player': NEWBIE } })).json();
    expect(after.energy.value).toBe(before.energy.value);
  });
});
