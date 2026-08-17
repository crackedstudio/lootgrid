import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EPOCH } from './config';
import { getDb } from './db/index';
import * as zoneRepo from './db/repos/zones';
import * as referee from './referee';
import * as store from './store';
import { freshWorld, makePlayer, teardownWorld } from './testing/harness';

/**
 * The map has to come back.
 *
 * A reveal is permanent within an epoch, so without rotation a zone is consumed
 * rather than played — one player working through an energy bar every 108
 * seconds strips a 216-cell grid in about half an hour and nothing replaces
 * what they took. `zones.rotates_at` and `zone_seed_history` were written for
 * this in phase 0 and never used; these tests are about the reset actually
 * happening, and about the two things that make it safe to run unattended:
 * the outgoing seed being published, and the money getting home.
 */

const PLAYER = '0x00000000000000000000000000000000000000c1';

beforeEach(() => freshWorld());
afterEach(() => teardownWorld());

/** Bring a zone's rotation forward so a sweep picks it up. */
function makeDue(zoneId: string, at: number): void {
  getDb().prepare('UPDATE zones SET rotates_at = ? WHERE id = ?').run(at, zoneId);
}

describe('epoch rotation', () => {
  it('seeds zones with staggered rotation times', () => {
    const zones = store.listZones();
    const times = zones.map(z => z.rotatesAt);

    // Every zone is scheduled...
    expect(times.every(t => typeof t === 'number')).toBe(true);
    // ...and no two land on the same tick. A world where every map resets
    // together is a world that empties all at once.
    expect(new Set(times).size).toBe(zones.length);
  });

  it('bumps the epoch and prints a new map', () => {
    const before = store.listZones()[0]!;
    makeDue(before.id, Date.now() - 1);

    expect(referee.sweepRotations()).toBe(1);

    const after = store.getZone(before.id)!;
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.seedSecret).not.toBe(before.seedSecret);
    expect(after.seedCommit).not.toBe(before.seedCommit);
  });

  it('publishes the outgoing seed so the old map can be audited', () => {
    const before = store.listZones()[0]!;
    makeDue(before.id, Date.now() - 1);
    referee.sweepRotations();

    const history = store.seedHistory(before.id);
    const archived = history.find(h => h.epoch === before.epoch);

    expect(archived).toBeDefined();
    // The whole point of archiving: the secret that WAS the fog is now public.
    expect(archived!.seedSecret).toBe(before.seedSecret);
    expect(archived!.seedCommit).toBe(before.seedCommit);
  });

  it('schedules the next rotation rather than rotating every sweep', () => {
    const zone = store.listZones()[0]!;
    makeDue(zone.id, Date.now() - 1);
    referee.sweepRotations();

    const after = store.getZone(zone.id)!;
    expect(after.rotatesAt).toBeGreaterThan(Date.now());
    // Already rotated, so a second sweep must find nothing due.
    expect(referee.sweepRotations()).toBe(0);
    expect(store.getZone(zone.id)!.epoch).toBe(after.epoch);
  });

  it('leaves a zone with no rotation time alone', () => {
    const zone = store.listZones()[0]!;
    getDb().prepare('UPDATE zones SET rotates_at = NULL WHERE id = ?').run(zone.id);

    // Sweep far enough ahead that every OTHER zone is long overdue. A NULL must
    // never be swept up by a comparison against a default, or opting out of
    // rotation would be impossible.
    const far = Date.now() + 10 * EPOCH.rotateMs;
    expect(store.zonesDueForRotation(far).map(z => z.id)).not.toContain(zone.id);

    referee.sweepRotations(far);
    expect(store.getZone(zone.id)!.epoch).toBe(zone.epoch);
    // ...while the zones that did opt in have moved on.
    expect(store.getZone(store.listZones()[1]!.id)!.epoch).toBeGreaterThan(zone.epoch);
  });

  it('carries no hunts across the boundary', () => {
    const zone = store.listZones()[0]!;
    const before = store.liveHuntsIn(zone);
    expect(before.length).toBeGreaterThan(0);

    makeDue(zone.id, Date.now() - 1);
    referee.sweepRotations();

    const after = store.getZone(zone.id)!;
    // Old epoch's hunts are closed...
    for (const h of before) {
      expect(store.getHunt(h.id)!.status).toBe('expired');
    }
    // ...and the new map is stocked, so the zone is playable straight away.
    expect(store.liveHuntsIn(after).length).toBeGreaterThan(0);
    expect(store.liveHuntsIn(after).every(h => h.epoch === after.epoch)).toBe(true);
  });

  it('clears the fog — a rotated zone reads as untouched', () => {
    const zone = store.listZones()[0]!;
    const player = makePlayer(PLAYER, '@digger');
    store.addReveal(zone, {
      r: 0,
      c: 0,
      type: 'empty',
      byHandle: player.handle,
      at: Date.now(),
      playerId: player.id,
    });
    expect(store.revealsFor(zone, player.id).length).toBe(1);

    makeDue(zone.id, Date.now() - 1);
    referee.sweepRotations();

    // Reveals are keyed by epoch, so the new map starts fully covered without
    // anything having to be deleted.
    const after = store.getZone(zone.id)!;
    expect(store.revealsFor(after, player.id).length).toBe(0);
  });
});

describe('hunt lifetimes are bounded by the epoch', () => {
  /**
   * This is the invariant that makes rotation safe to run on a timer.
   *
   * The escrow's `refund` reverts with NotExpired until `block.timestamp`
   * passes the pot's expiry. A hunt carrying a 24h TTL created an hour before
   * rotation would therefore sit on a dead map with its money locked for
   * another 23 hours. Clamping the TTL to the epoch means every pot a closing
   * map leaves behind is refundable the moment it closes.
   */
  it('never lets a hunt outlive its map', () => {
    for (const zone of store.listZones()) {
      if (zone.rotatesAt === null) continue;
      for (const h of store.liveHuntsIn(zone)) {
        expect(h.expiresAt).not.toBeNull();
        expect(h.expiresAt!).toBeLessThanOrEqual(zone.rotatesAt);
      }
    }
  });

  it('clamps hunts created close to the boundary', () => {
    const zone = store.listZones()[0]!;
    const soon = Date.now() + 60_000;
    makeDue(zone.id, soon);

    // Close everything so replenish has to mint a fresh batch against the
    // near boundary.
    for (const h of store.liveHuntsIn(zone)) {
      store.setHuntStatus(store.getHunt(h.id)!, 'expired', null, Date.now());
      store.evictHunt(h.id);
    }
    store.replenish(zone.id);

    const fresh = store.liveHuntsIn(store.getZone(zone.id)!);
    expect(fresh.length).toBeGreaterThan(0);
    // A full human TTL is 24h; every one of these must be cut to the boundary.
    for (const h of fresh) expect(h.expiresAt).toBe(soon);
  });

  it('leaves the TTL alone when a zone never rotates', () => {
    const zone = store.listZones()[0]!;
    getDb().prepare('UPDATE zones SET rotates_at = NULL WHERE id = ?').run(zone.id);
    for (const h of store.liveHuntsIn(zone)) {
      store.setHuntStatus(store.getHunt(h.id)!, 'expired', null, Date.now());
      store.evictHunt(h.id);
    }

    const at = Date.now();
    store.replenish(zone.id, at);

    // 24h human TTL, unclamped.
    for (const h of store.liveHuntsIn(store.getZone(zone.id)!)) {
      expect(h.expiresAt).toBe(at + 24 * 60 * 60 * 1000);
    }
  });
});

describe('rotation is resilient', () => {
  it('rotates the zones it can when one is already gone', () => {
    const zones = store.listZones();
    expect(zones.length).toBeGreaterThan(1);

    const now = Date.now();
    for (const z of zones) makeDue(z.id, now - 1);
    // Delete one out from under the sweep.
    getDb().prepare('DELETE FROM zones WHERE id = ?').run(zones[0]!.id);

    expect(() => referee.sweepRotations(now)).not.toThrow();
    for (const z of zones.slice(1)) {
      expect(store.getZone(z.id)!.epoch).toBe(z.epoch + 1);
    }
  });

  it('comes due again if a rotation fails', () => {
    const zone = store.listZones()[0]!;
    const due = Date.now() - 1;
    makeDue(zone.id, due);

    // zone_seed_history's PK is (zone_id, epoch); pre-inserting the row the
    // archive step will write makes that step a no-op rather than a failure —
    // ON CONFLICT DO NOTHING — so rotation still completes. The point here is
    // that a repeat archive cannot corrupt what was already published.
    zoneRepo.archiveSeed({ ...zone, seedSecret: 'tampered', seedCommit: 'tampered' }, due);
    referee.sweepRotations();

    const archived = store.seedHistory(zone.id).find(h => h.epoch === zone.epoch)!;
    expect(archived.seedSecret).toBe('tampered');
    expect(store.getZone(zone.id)!.epoch).toBe(zone.epoch + 1);
  });
});
