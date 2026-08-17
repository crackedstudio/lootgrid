import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from './appTypes';
import { ENERGY, GRID, SURVEY } from './config';
import { registerRoutes } from './http';
import * as referee from './referee';
import * as store from './store';
import { bandFor, read } from './survey';
import { freshWorld, teardownWorld } from './testing/harness';
import type { Hunt } from './types';

/**
 * Survey — the hot/cold detector.
 *
 * Two properties matter more than the arithmetic. It must burn energy without
 * consuming map, because that is what lets a zone survive being played hard on
 * a 3,600-cell grid. And it must never return a distance, because two precise
 * readings would pin a treasure exactly and the map would stop being worth
 * exploring.
 */

const PLAYER = '0x00000000000000000000000000000000000000e1';

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

const surveyAt = (r: number, c: number) =>
  app.inject({
    method: 'POST',
    url: `/zones/ridge/survey/${r}/${c}`,
    headers: { 'x-player': PLAYER },
  });

const gridFor = () =>
  app
    .inject({ method: 'GET', url: '/zones/ridge/grid', headers: { 'x-player': PLAYER } })
    .then(r => r.json().reveals as unknown[]);

describe('banding', () => {
  it('reports warmer bands for closer treasure', () => {
    expect(bandFor(0)).toBe('burning');
    expect(bandFor(SURVEY.bands[0]!.within)).toBe('burning');
    expect(bandFor(SURVEY.bands[0]!.within + 1)).toBe('hot');
    expect(bandFor(GRID.rows + GRID.cols)).toBe(SURVEY.coldest);
  });

  it('is monotonic — a further treasure never reads warmer', () => {
    const order = [...SURVEY.bands.map(b => b.name), SURVEY.coldest] as string[];
    let last = 0;
    for (let d = 0; d <= GRID.rows; d++) {
      const idx = order.indexOf(bandFor(d));
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
  });

  it('reads the NEAREST treasure, not an arbitrary one', () => {
    const hunts = [
      { id: 'far', r: 50, c: 50 },
      { id: 'near', r: 2, c: 2 },
    ] as Hunt[];
    expect(read(hunts, 0, 0)!.band).toBe('burning');
    // Order of the list must not matter.
    expect(read([...hunts].reverse(), 0, 0)!.band).toBe('burning');
  });

  it('returns nothing when the zone holds no treasure', () => {
    // "cold" would imply something is out there. Refusing is the honest answer.
    expect(read([], 5, 5)).toBeNull();
  });
});

describe('the reading never leaks a distance', () => {
  it('carries a band and no numeric distance', async () => {
    const res = await surveyAt(10, 10);
    const reading = res.json().reading as Record<string, unknown>;

    expect(typeof reading.band).toBe('string');
    // Anything numeric beyond the surveyed cell and a timestamp would be enough
    // to triangulate exactly. `scale` is a count of bands, not a measurement.
    expect(Object.keys(reading).sort()).toEqual(['at', 'band', 'c', 'r', 'scale']);
  });

  it('does not say which treasure it found', async () => {
    // On a 24-treasure map, naming the target would let a player split their
    // readings per hunt and solve each one separately — a far easier problem
    // than "something is near here".
    const body = (await surveyAt(30, 30)).body;
    for (const h of store.liveHuntsIn(store.getZone('ridge')!)) {
      expect(body).not.toContain(h.id);
    }
  });
});

describe('what it costs and what it leaves behind', () => {
  it('charges the survey cost', async () => {
    const res = await surveyAt(20, 20);
    expect(res.statusCode).toBe(200);
    expect(res.json().energy.value).toBe(ENERGY.start - SURVEY.cost);
  });

  /**
   * The property the whole design rests on.
   *
   * Every other energy sink permanently removes a tile from the world. If
   * Survey did too, a zone's life would still fall with every player who showed
   * up, and phase 1's rotation would be papering over a leak rather than
   * closing it.
   */
  it('uncovers nothing', async () => {
    expect(await gridFor()).toHaveLength(0);
    await surveyAt(15, 15);
    await surveyAt(40, 40);
    expect(await gridFor()).toHaveLength(0);
  });

  it('refuses when the player cannot afford it', async () => {
    // Drain the bar with surveys, then ask for one more.
    for (let i = 0; i < Math.ceil(ENERGY.start / SURVEY.cost); i++) {
      await surveyAt(i, i);
    }
    const res = await surveyAt(1, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('insufficient_energy');
  });

  it('can be taken from a cell that has already been dug', async () => {
    // You are reading the ground from a position, not interacting with the
    // tile. Refusing would also leak which cells are special.
    await app.inject({
      method: 'POST',
      url: '/zones/ridge/tiles/7/7/open',
      headers: { 'x-player': PLAYER },
    });
    expect((await surveyAt(7, 7)).statusCode).toBe(200);
  });
});

describe('three readings narrow the field', () => {
  /**
   * Synthetic treasure, not a seeded world.
   *
   * `read` is a pure function of a hunt list, and building the list here is the
   * difference between testing the detector and testing where `replenish`
   * happened to scatter twenty-four hunts. The first version of this used the
   * real world and failed about one run in three — always because some other
   * treasure was nearer to a vantage point than the intended one, which is a
   * true fact about the map and nothing to do with what is being asserted.
   */
  const hunt = (id: string, r: number, c: number) => ({ id, r, c }) as Hunt;

  /** Cells whose distance to `p` falls in the same band the reading reported. */
  const consistent = (p: { r: number; c: number; band: string }) => {
    const out = new Set<string>();
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        if (bandFor(Math.max(Math.abs(r - p.r), Math.abs(c - p.c))) === p.band) out.add(`${r},${c}`);
      }
    }
    return out;
  };

  const intersect = (live: Hunt[], points: Array<{ r: number; c: number }>) => {
    const sets = points.map(p => consistent({ ...p, band: read(live, p.r, p.c)!.band }));
    return {
      all: [...sets[0]!].filter(k => sets.every(s => s.has(k))),
      smallest: Math.min(...sets.map(s => s.size)),
    };
  };

  /**
   * The reason Survey exists: it has to make deduction possible, not flavour.
   *
   * Three readings taken around one treasure must leave a materially smaller
   * field than any of them alone, and the treasure must survive all three.
   */
  it('intersects to far fewer candidates than a single reading', () => {
    const live = [hunt('only', 30, 30)];
    const { all, smallest } = intersect(live, [
      { r: 24, c: 24 },
      { r: 36, c: 26 },
      { r: 28, c: 38 },
    ]);

    expect(all).toContain('30,30');
    // A wide margin, not a technicality. That gap is the deduction the whole
    // economy is priced around.
    expect(all.length).toBeLessThan(smallest / 2);
  });

  it('sharpens further as readings are added', () => {
    const live = [hunt('only', 30, 30)];
    const one = intersect(live, [{ r: 24, c: 24 }]).all.length;
    const two = intersect(live, [{ r: 24, c: 24 }, { r: 36, c: 26 }]).all.length;
    const three = intersect(live, [{ r: 24, c: 24 }, { r: 36, c: 26 }, { r: 28, c: 38 }]).all.length;

    expect(two).toBeLessThan(one);
    expect(three).toBeLessThan(two);
  });

  /**
   * The counterpart, asserted so nobody "fixes" the detector to make it work.
   *
   * Each reading reports the nearest treasure, so readings taken beside
   * different treasures describe different things and combining them is
   * meaningless. This is a consequence of putting twenty-four treasures on the
   * grid, not a defect in Survey — see the note in survey.ts.
   */
  it('does not triangulate across treasures', () => {
    const live = [hunt('a', 5, 5), hunt('b', 55, 55)];
    // Each vantage point sits on top of a different treasure, so both read
    // `burning` about different things.
    const { all } = intersect(live, [
      { r: 5, c: 5 },
      { r: 55, c: 55 },
    ]);

    // Not a narrower answer — a contradictory one.
    expect(all.length).toBe(0);
  });
});
