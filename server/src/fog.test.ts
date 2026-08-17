import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GRID } from './config';
import * as store from './store';
import { freshWorld, makePlayer, teardownWorld } from './testing/harness';
import type { Zone } from './types';

/**
 * Your map is yours.
 *
 * Everyone hunts the same treasure in the same zone; what you have personally
 * uncovered, only you see. The shared map was doing four kinds of damage at
 * once and this is the one change that addresses all of them — so these tests
 * are written as the four properties, not as CRUD over a table.
 */

const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b1';

beforeEach(() => freshWorld());
afterEach(() => teardownWorld());

function dig(zone: Zone, who: string, r: number, c: number): boolean {
  const player = makePlayer(who);
  return store.addReveal(zone, {
    r,
    c,
    type: 'empty',
    byHandle: player.handle,
    at: Date.now(),
    playerId: player.id,
  });
}

describe('discovery is private', () => {
  it('keeps one player’s digs out of another’s map', () => {
    const zone = store.listZones()[0]!;
    dig(zone, ALICE, 3, 3);

    expect(store.revealsFor(zone, ALICE)).toHaveLength(1);
    expect(store.revealsFor(zone, BOB)).toHaveLength(0);
  });

  it('lets two players open the same tile independently', () => {
    const zone = store.listZones()[0]!;

    // Under a shared map the second of these lost a race and got a refund.
    // There is no race any more: Bob is buying his own information.
    expect(dig(zone, ALICE, 5, 5)).toBe(true);
    expect(dig(zone, BOB, 5, 5)).toBe(true);

    expect(store.getReveal(zone, ALICE, 5, 5)).toBeDefined();
    expect(store.getReveal(zone, BOB, 5, 5)).toBeDefined();
  });

  it('still refuses the same player opening one tile twice', () => {
    const zone = store.listZones()[0]!;
    expect(dig(zone, ALICE, 7, 2)).toBe(true);
    // A double-tap or a retried request — the caller refunds the energy.
    expect(dig(zone, ALICE, 7, 2)).toBe(false);
    expect(store.revealsFor(zone, ALICE)).toHaveLength(1);
  });

  it('scopes a map to its epoch as well as its player', () => {
    const zone = store.listZones()[0]!;
    dig(zone, ALICE, 1, 1);

    const nextEpoch: Zone = { ...zone, epoch: zone.epoch + 1 };
    expect(store.revealsFor(nextEpoch, ALICE)).toHaveLength(0);
  });
});

describe('the map is no longer consumable', () => {
  /**
   * The property that makes a zone survivable.
   *
   * Under a shared map, a zone's remaining life fell as players arrived —
   * fifty accounts stripped it fifty times faster, which is precisely
   * backwards. Now each map is worn down only by its own owner.
   */
  it('does not let one player wear down anybody else’s map', () => {
    const zone = store.listZones()[0]!;

    // Alice strips a whole row.
    for (let c = 0; c < GRID.cols; c++) dig(zone, ALICE, 0, c);

    expect(store.revealsFor(zone, ALICE)).toHaveLength(GRID.cols);
    // Bob's map is untouched — his exploration cost is unchanged by hers.
    expect(store.revealsFor(zone, BOB)).toHaveLength(0);
    for (let c = 0; c < GRID.cols; c++) {
      expect(store.getReveal(zone, BOB, 0, c)).toBeUndefined();
    }
  });

  it('places hunts without regard to who has dug where', () => {
    const zone = store.listZones()[0]!;

    // Alice digs out most of the grid.
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) dig(zone, ALICE, r, c);
    }

    // Close everything and restock. Under the old rule — skip any revealed
    // cell — replenish would have had nowhere left to put a hunt and the zone
    // would have quietly died. Placement is a property of the zone, not of one
    // player's map, so it must not even consult the fog.
    for (const h of store.liveHuntsIn(zone)) {
      store.setHuntStatus(store.getHunt(h.id)!, 'expired', null, Date.now());
      store.evictHunt(h.id);
    }
    expect(store.replenish(zone.id)).toBeGreaterThan(0);
    expect(store.liveHuntsIn(store.getZone(zone.id)!).length).toBeGreaterThan(0);
  });
});
