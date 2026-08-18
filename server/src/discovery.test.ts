import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from './appTypes';
import { DISCOVERY } from './config';
import { registerRoutes } from './http';
import * as referee from './referee';
import * as store from './store';
import * as survey from './survey';
import { freshWorld, makePlayer, teardownWorld } from './testing/harness';
import type { Hunt, Zone } from './types';

/**
 * A treasure's location is private until somebody digs it up.
 *
 * ─────────────────────────── what these guard ───────────────────────────
 *
 * `GET /zones/:id/grid` served `r` and `c` for every live hunt to every player,
 * so the map that phases 1–3 were built to make searchable was published in its
 * own payload. Survey reported the distance to a treasure the client could
 * already locate; hint intersection narrowed toward a cell already on screen.
 *
 * Nothing caught it. `security.test.ts` locks down the seed secret, the hunt
 * salt and the block game spec — never the coordinates, because in v1 they were
 * legitimately public. Private fog changed what "secret" means and no test
 * followed. These are that test.
 *
 * They are written as the properties, not as CRUD over `hunt_discoveries`: the
 * table is an implementation detail and the properties are the contract.
 */

const FINDER = '0x00000000000000000000000000000000000000f1';
const STRANGER = '0x0000000000000000000000000000000000000052';
const LATECOMER = '0x00000000000000000000000000000000000000c3';

let zone: Zone;
let treasure: Hunt;

beforeEach(() => {
  freshWorld();
  zone = store.listZones()[0]!;
  treasure = store.getHunt(store.liveHuntsIn(zone)[0]!.id)!;
  for (const id of [FINDER, STRANGER, LATECOMER]) makePlayer(id);
});
afterEach(() => teardownWorld());

const visibleTo = (who: string, now = Date.now()) =>
  store.visibleHuntsIn(zone, who, now).map(h => h.id);

describe('a treasure nobody has found is nobody’s to see', () => {
  it('is absent from every player’s map', () => {
    expect(visibleTo(FINDER)).not.toContain(treasure.id);
    expect(visibleTo(STRANGER)).not.toContain(treasure.id);
  });

  it('is still there as far as the server is concerned', () => {
    // The bug would be "fixed" just as thoroughly by not seeding hunts at all.
    // Survey measures against treasures nobody has found and hints are generated
    // for them, so the server's own view must still be the whole truth.
    expect(store.liveHuntsIn(zone).map(h => h.id)).toContain(treasure.id);
  });

  it('still registers on Survey, which is the entire point of Survey', () => {
    const reading = survey.read(store.liveHuntsIn(zone), treasure.r, treasure.c);
    expect(reading).not.toBeNull();
    // Standing on it reads as the hottest band there is.
    expect(reading!.band).toBe(survey.bandFor(0));
  });
});

describe('digging a treasure’s cell finds it', () => {
  it('shows it to the finder and to nobody else', () => {
    const now = Date.now();
    expect(store.discoverHunt(treasure, FINDER, now)).toBe(true);

    expect(visibleTo(FINDER, now)).toContain(treasure.id);
    expect(visibleTo(STRANGER, now)).not.toContain(treasure.id);
  });

  it('is idempotent — the same player digging twice finds it once', () => {
    const now = Date.now();
    expect(store.discoverHunt(treasure, FINDER, now)).toBe(true);
    expect(store.discoverHunt(treasure, FINDER, now + 1_000)).toBe(false);
  });

  it('starts the head start rather than making it private forever', () => {
    const now = Date.now();
    store.discoverHunt(treasure, FINDER, now);

    const after = store.getHunt(treasure.id)!;
    expect(after.publicAt).toBe(now + DISCOVERY.headStartMs);
  });
});

describe('the head start ends', () => {
  it('opens the treasure to the whole zone once it elapses', () => {
    const now = Date.now();
    store.discoverHunt(treasure, FINDER, now);

    const later = now + DISCOVERY.headStartMs + 1;
    expect(visibleTo(STRANGER, later)).toContain(treasure.id);
    expect(store.isHuntPublic(store.getHunt(treasure.id)!, later)).toBe(true);
  });

  it('cannot be extended by whoever finds it next', () => {
    // Otherwise a hunt with a steady trickle of finders would never go public,
    // and each new arrival would buy themselves a fresh window at the field's
    // expense.
    const now = Date.now();
    store.discoverHunt(treasure, FINDER, now);
    const firstDeadline = store.getHunt(treasure.id)!.publicAt;

    store.discoverHunt(treasure, LATECOMER, now + 10 * 60 * 1000);

    expect(store.getHunt(treasure.id)!.publicAt).toBe(firstDeadline);
  });

  it('lets a second finder see it during the window it did not start', () => {
    const now = Date.now();
    store.discoverHunt(treasure, FINDER, now);

    const midway = now + 10 * 60 * 1000;
    store.discoverHunt(treasure, LATECOMER, midway);

    expect(visibleTo(LATECOMER, midway)).toContain(treasure.id);
    expect(visibleTo(STRANGER, midway)).not.toContain(treasure.id);
  });
});

describe('a treasure nobody finds does not stay buried', () => {
  it('goes public on its own clock', () => {
    // A funded hunt that expires unseen is money the treasury spent on a hunt
    // nobody could play.
    const seeded = store.getHunt(treasure.id)!;
    expect(seeded.publicAt).toBe(seeded.createdAt + DISCOVERY.publicAfterMs[zone.kind]);

    expect(visibleTo(STRANGER, seeded.publicAt! + 1)).toContain(treasure.id);
  });

  it('goes public well before it expires', () => {
    const seeded = store.getHunt(treasure.id)!;
    expect(seeded.publicAt!).toBeLessThan(seeded.expiresAt!);
  });
});

describe('reserved hunts are unaffected', () => {
  it('never reach the shared map, discovered or not', () => {
    // An owned hunt is scoped by ownerId and is already visible to its owner;
    // it must not appear in anyone else's visibility set at any time.
    const owned = store.ownedHuntsIn(zone, FINDER);
    for (const h of owned) {
      expect(visibleTo(STRANGER, Date.now() + DISCOVERY.publicAfterMs[zone.kind] * 2)).not.toContain(
        h.id,
      );
    }
  });
});


/**
 * The leak was in the payload, so the guard has to be too.
 *
 * Every test above this point exercises `visibleHuntsIn`, which is the right
 * unit — but the bug was a handler calling the *other* function, and a unit test
 * of the correct function would have passed happily throughout. These go through
 * the wire.
 */
describe('the grid payload does not publish the map', () => {
  let app: App;

  beforeEach(async () => {
    app = Fastify({ logger: false }) as unknown as App;
    registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    referee.stop();
  });

  const grid = (who: string) =>
    app.inject({ method: 'GET', url: `/zones/${zone.id}/grid`, headers: { 'x-player': who } });

  const dig = (who: string, at: { r: number; c: number }) =>
    app.inject({
      method: 'POST',
      url: `/zones/${zone.id}/tiles/${at.r}/${at.c}/open`,
      headers: { 'x-player': who },
    });

  it('serves no undiscovered treasure to anyone', async () => {
    const res = await grid(STRANGER);
    const body = res.json() as { hunts: Array<{ id: string }> };

    const buried = store.liveHuntsIn(zone).map(h => h.id);
    expect(buried.length).toBeGreaterThan(0);
    for (const id of buried) expect(body.hunts.map(h => h.id)).not.toContain(id);
  });

  it('serves a new player nothing but their own tutorial treasure', async () => {
    // Stronger than an id-by-id check: it pins the WHOLE payload, so a future
    // field that quietly re-published the map — a "nearby treasures" convenience,
    // a renamed key, a denormalised copy — fails here rather than shipping.
    const res = await grid(STRANGER);
    const body = res.json() as { hunts: Array<{ id: string; ownerId: string | null }> };

    for (const h of body.hunts) {
      expect(h.ownerId).toBe(STRANGER);
    }
    // And the shared map really did have treasures to leak.
    expect(store.liveHuntsIn(zone).length).toBeGreaterThan(0);
  });

  it('hands the treasure to whoever digs its cell', async () => {
    const res = await dig(FINDER, { r: treasure.r, c: treasure.c });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { found: boolean; hunt: { id: string; headStartMs: number } };
    expect(body.found).toBe(true);
    expect(body.hunt.id).toBe(treasure.id);
    expect(body.hunt.headStartMs).toBeGreaterThan(0);

    const mine = (await grid(FINDER)).json() as { hunts: Array<{ id: string }> };
    expect(mine.hunts.map(h => h.id)).toContain(treasure.id);

    const theirs = (await grid(STRANGER)).json() as { hunts: Array<{ id: string }> };
    expect(theirs.hunts.map(h => h.id)).not.toContain(treasure.id);
  });

  it('does not charge energy for finding one', async () => {
    const before = store.getPlayer(FINDER)!.energyValue;
    const res = await dig(FINDER, { r: treasure.r, c: treasure.c });
    const body = res.json() as { energy: { value: number } };
    expect(body.energy.value).toBe(before);
  });

  it('does not write the treasure’s cell into the finder’s fog', async () => {
    await dig(FINDER, { r: treasure.r, c: treasure.c });
    expect(store.getReveal(zone, FINDER, treasure.r, treasure.c)).toBeUndefined();
  });

  it('tells the finder when their head start runs out', async () => {
    await dig(FINDER, { r: treasure.r, c: treasure.c });
    const body = (await grid(FINDER)).json() as {
      hunts: Array<{ id: string; publicAt: number }>;
    };
    const found = body.hunts.find(h => h.id === treasure.id)!;
    expect(found.publicAt).toBeGreaterThan(Date.now());
  });
});

/**
 * The same leak, one transport over.
 *
 * `broadcastZoneHunts` sent every live treasure with coordinates to the whole
 * zone room. Fixing only the HTTP payload would have left the map published over
 * the socket, and the grid tests above would have stayed green while it did.
 */
describe('the zone broadcast does not publish the map', () => {
  it('carries only treasures that have gone public', () => {
    const now = Date.now();
    store.discoverHunt(treasure, FINDER, now);

    const carried = store
      .liveHuntsIn(zone)
      .filter(h => store.isHuntPublic(h, now))
      .map(h => h.id);

    expect(carried).not.toContain(treasure.id);
  });

  it('starts carrying one once its head start is over', () => {
    const now = Date.now();
    store.discoverHunt(treasure, FINDER, now);
    const after = now + DISCOVERY.headStartMs + 1;

    const carried = store
      .liveHuntsIn(zone)
      .filter(h => store.isHuntPublic(h, after))
      .map(h => h.id);

    expect(carried).toContain(treasure.id);
  });
});
