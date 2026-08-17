import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from './appTypes';
import { ENERGY, GRID, TILES } from './config';
import { tileType } from './grid';
import * as hints from './hints';
import { registerRoutes } from './http';
import * as referee from './referee';
import * as store from './store';
import { freshWorld, teardownWorld } from './testing/harness';
import type { TileType } from './types';

/**
 * The five tile types have to mean something.
 *
 * They have been labelled empty / clue / trap / mystery / puzzle since phase 0
 * and none of them did anything: a trap cost nothing, a clue gave no clue, and
 * the onboarding promised a warmth mechanic that existed nowhere in the game. A
 * player's first tap taught them our words are decorative.
 *
 * These tests are the guarantee that each label now has a consequence, written
 * against the HTTP surface because that is where a player experiences it.
 */

const PLAYER = '0x00000000000000000000000000000000000000d1';

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

/** A cell of the given type with no hunt on it. */
function cellOfType(want: TileType): { r: number; c: number } {
  const zone = store.getZone('ridge')!;
  const taken = new Set(store.liveHuntsIn(zone).map(h => `${h.r},${h.c}`));
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      if (taken.has(`${r},${c}`)) continue;
      if (tileType(zone, r, c) === want) return { r, c };
    }
  }
  throw new Error(`no free ${want} tile in the zone`);
}

const open = (at: { r: number; c: number }) =>
  app.inject({
    method: 'POST',
    url: `/zones/ridge/tiles/${at.r}/${at.c}/open`,
    headers: { 'x-player': PLAYER },
  });

describe('a trap costs something', () => {
  it('charges double what an empty tile charges', async () => {
    const emptyRes = await open(cellOfType('empty'));
    const afterEmpty = emptyRes.json().energy.value as number;

    const trapRes = await open(cellOfType('trap'));
    const afterTrap = trapRes.json().energy.value as number;

    // A player starts at ENERGY.start, not a full bar — and the refill is six
    // minutes a point, so nothing regenerates mid-test.
    const emptyCost = ENERGY.start - afterEmpty;
    const trapCost = afterEmpty - afterTrap;
    expect(trapCost).toBe(emptyCost * TILES.trap.energyMultiplier);
  });

  it('hands out a hint that is false', async () => {
    const trap = cellOfType('trap');
    const res = await open(trap);
    const hint = res.json().hint as { id: string } | null;

    // A trap always pays — it would be a poor trap that sometimes cost double
    // for nothing — and what it pays is a lie.
    expect(hint).not.toBeNull();

    const zone = store.getZone('ridge')!;
    const hunts = store.liveHuntsIn(zone);
    const all = hunts.flatMap(h => store.getHunt(h.id)!).flatMap(h => hintsOf(h.id));
    const record = all.find(h => h.id === hint!.id);
    expect(record).toBeDefined();
    expect(record!.isTrue).toBe(false);
  });

  /**
   * The lie has to come from the set that was published in advance.
   *
   * `hints/stats.ts` audits the committed set against its advertised tier
   * accuracy. If a trap fabricated a false hint outside that set, the published
   * honesty numbers would describe something other than what players actually
   * received — which is exactly the accusation the commitment scheme exists to
   * make impossible.
   */
  it('draws the lie from the hunt’s committed set', async () => {
    const res = await open(cellOfType('trap'));
    const hint = res.json().hint as { id: string; huntId: string };
    const committed = hintsOf(hint.huntId).map(h => h.id);
    expect(committed).toContain(hint.id);
  });
});

describe('a clue gives a clue', () => {
  it('always pays a hint, where an ordinary tile only sometimes does', async () => {
    // Every clue tile in the zone pays. The drop roll is skipped, not improved.
    const zone = store.getZone('ridge')!;
    const taken = new Set(store.liveHuntsIn(zone).map(h => `${h.r},${h.c}`));
    let checked = 0;

    for (let r = 0; r < GRID.rows && checked < 8; r++) {
      for (let c = 0; c < GRID.cols && checked < 8; c++) {
        if (taken.has(`${r},${c}`)) continue;
        if (tileType(zone, r, c) !== 'clue') continue;
        const res = await open({ r, c });
        if (res.statusCode !== 200) continue; // ran out of energy
        expect(res.json().hint, `clue at ${r},${c} paid nothing`).not.toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('a mystery opens a neighbour', () => {
  it('uncovers an adjacent tile for free', async () => {
    const cell = cellOfType('mystery');
    const before = (await grid()).length;
    const res = await open(cell);
    const bonus = res.json().bonus as Array<{ r: number; c: number }>;

    expect(bonus.length).toBe(TILES.mystery.freeNeighbours);
    // The bonus tile is adjacent, and it really is on the player's map now.
    for (const b of bonus) {
      expect(Math.max(Math.abs(b.r - cell.r), Math.abs(b.c - cell.c))).toBe(1);
    }
    expect((await grid()).length).toBe(before + 1 + bonus.length);
  });

  it('charges nothing for the neighbour', async () => {
    const emptyRes = await open(cellOfType('empty'));
    const oneTileCost = ENERGY.start - (emptyRes.json().energy.value as number);

    const before = (await grid()).length;
    const res = await open(cellOfType('mystery'));
    const spent = (emptyRes.json().energy.value as number) - (res.json().energy.value as number);

    // Two tiles appeared; one tile was paid for.
    expect((await grid()).length).toBe(before + 2);
    expect(spent).toBe(oneTileCost);
  });

  it('never hands over a tile with a hunt under it', async () => {
    // A mystery that could uncover treasure would be the best tile on the board
    // by a wide margin, and would do it invisibly.
    const zone = store.getZone('ridge')!;
    const hunts = new Set(store.liveHuntsIn(zone).map(h => `${h.r},${h.c}`));

    for (let i = 0; i < 6; i++) {
      const cell = cellOfType('mystery');
      const res = await open(cell);
      if (res.statusCode !== 200) break;
      for (const b of (res.json().bonus ?? []) as Array<{ r: number; c: number }>) {
        expect(hunts.has(`${b.r},${b.c}`)).toBe(false);
      }
      // Next iteration finds a different mystery tile, since this one is open.
    }
  });
});

describe('a puzzle tile pays XP', () => {
  it('credits the player and reports the new total', async () => {
    const res = await open(cellOfType('puzzle'));
    const xp = res.json().xp as { gained: number; total: number };

    expect(xp.gained).toBe(TILES.puzzle.xp);
    expect(store.getPlayer(PLAYER)!.xp).toBe(xp.total);
    expect(xp.total).toBeGreaterThanOrEqual(TILES.puzzle.xp);
  });

  it('pays nothing on an ordinary tile', async () => {
    const res = await open(cellOfType('empty'));
    expect(res.json().xp).toBeNull();
  });
});

// ---- helpers ----

async function grid(): Promise<Array<{ r: number; c: number }>> {
  const res = await app.inject({
    method: 'GET',
    url: '/zones/ridge/grid',
    headers: { 'x-player': PLAYER },
  });
  return res.json().reveals;
}

/** The hunt's committed hint set, truth flags included. Server-side only. */
function hintsOf(huntId: string) {
  return hints.forHunt(store.getHunt(huntId)!);
}
