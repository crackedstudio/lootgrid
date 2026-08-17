import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENERGY, KEYS, PASS } from '../config';
import * as shopRepo from '../db/repos/shop';
import * as energy from '../energy';
import * as hints from '../hints';
import * as keys from '../keys';
import * as shop from './index';
import * as store from '../store';
import { freshWorld, huntOfType, makePlayer, makeVeteran, teardownWorld } from '../testing/harness';

/**
 * The shop.
 *
 * One assertion here matters more than the rest: **money never buys a chance at
 * the prize.** It is the sentence handed to a lawyer, the thing that keeps this
 * off the gambling line, and the reason the two-currency split exists at all.
 * Everything else is commerce.
 */

const BUYER = '0x00000000000000000000000000000000000000c9';

beforeEach(() => freshWorld());
afterEach(() => teardownWorld());

const buy = (playerId: string, sku: string, now = Date.now()) =>
  shop.fulfil(makePlayer(playerId), shop.itemFor(sku)!, null, now);

describe('the line money cannot cross', () => {
  /**
   * The rule, tested from the outside.
   *
   * `Grant` has no member that could produce an entry, and there is nothing for
   * such a member to write to — a key is a count of cash attempts already
   * recorded, subtracted from a constant. This buys the entire catalogue and
   * checks the allowance did not move.
   */
  it('leaves the key allowance untouched, whatever is bought', () => {
    const player = makeVeteran(BUYER);
    const before = keys.balance(player.id);

    for (const item of shop.CATALOGUE) {
      shop.fulfil(player, item, null);
    }

    const after = keys.balance(player.id);
    expect(after.remaining).toBe(before.remaining);
    expect(after.perDay).toBe(KEYS.perDay);
  });

  it('sells nothing that grants an entry, a key or a retry', () => {
    // Read as a catalogue audit rather than a type check: the union cannot be
    // asserted at runtime, but what every item actually grants can be.
    const kinds = new Set(shop.CATALOGUE.map(i => i.grant.kind));
    expect([...kinds].sort()).toEqual(['compass', 'energy', 'pass', 'refillCredits']);
    for (const forbidden of ['key', 'entry', 'retry', 'revive', 'attempt']) {
      expect([...kinds]).not.toContain(forbidden);
    }
  });

  it('prices everything for ten five-cent buyers, not one big one', () => {
    // MiniPay lets us charge five cents and keep five cents, which is the whole
    // reason these numbers look wrong for a mobile game.
    for (const item of shop.CATALOGUE) {
      expect(item.priceCents, item.sku).toBeLessThanOrEqual(50);
    }
  });
});

describe('what a purchase does', () => {
  it('records the price as charged, not as listed later', () => {
    // The payout ratio is computed from this log. A price re-read from the
    // catalogue would misdescribe last month's revenue the moment prices move.
    buy(BUYER, 'refill');
    const rows = shopRepo.purchasesOf(BUYER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priceCents).toBe(shop.itemFor('refill')!.priceCents);
  });

  it('fills the bar without overflowing it', () => {
    const player = makePlayer(BUYER);
    const now = Date.now();
    energy.spend(player, 20, now);
    store.savePlayerEnergy(player);

    shop.fulfil(player, shop.itemFor('refill')!, null, now);
    expect(energy.currentEnergy(player, now)).toBe(ENERGY.max);
  });

  it('banks refills rather than spending them', () => {
    const player = makePlayer(BUYER);
    const now = Date.now();
    energy.spend(player, 25, now);
    store.savePlayerEnergy(player);
    const low = energy.currentEnergy(player, now);

    shop.fulfil(player, shop.itemFor('refill5')!, null, now);
    // Buying five refills does not spend one.
    expect(energy.currentEnergy(player, now)).toBe(low);

    expect(shop.useRefillCredit(player, now)).toBe(true);
    expect(energy.currentEnergy(player, now)).toBe(ENERGY.max);
  });

  it('runs out of banked refills honestly', () => {
    const player = makePlayer(BUYER);
    shop.fulfil(player, shop.itemFor('refill5')!, null);
    for (let i = 0; i < 5; i++) expect(shop.useRefillCredit(player)).toBe(true);
    expect(shop.useRefillCredit(player)).toBe(false);
  });
});

describe('the Cycle Pass sells tempo', () => {
  it('doubles the refill rate while it lasts', () => {
    const player = makePlayer(BUYER);
    const now = Date.now();
    expect(energy.regenMsFor(player, now)).toBe(ENERGY.regenMs);

    shop.fulfil(player, shop.itemFor('cyclepass')!, null, now);
    expect(energy.regenMsFor(player, now)).toBe(ENERGY.regenMs / PASS.regenMultiplier);
  });

  it('lapses on its own', () => {
    const player = makePlayer(BUYER);
    const now = Date.now();
    shop.fulfil(player, shop.itemFor('cyclepass')!, null, now);

    const after = now + 4 * PASS.dayMs;
    expect(energy.regenMsFor(player, after)).toBe(ENERGY.regenMs);
    expect(shop.hasPass(player.id, after)).toBe(false);
  });

  it('extends rather than replaces when bought twice', () => {
    // Buying something twice must never be worth less than buying it twice.
    const player = makePlayer(BUYER);
    const now = Date.now();
    shop.fulfil(player, shop.itemFor('cyclepass')!, null, now);
    const first = player.passUntil!;
    shop.fulfil(player, shop.itemFor('cyclepass')!, null, now);

    expect(player.passUntil!).toBeGreaterThan(first);
    expect(player.passUntil! - first).toBe(3 * PASS.dayMs);
  });

  it('tops the bar up once a day, and only while active', () => {
    const player = makePlayer(BUYER);
    const now = Date.now();
    shop.fulfil(player, shop.itemFor('cyclepass')!, null, now);

    energy.spend(player, 30, now);
    store.savePlayerEnergy(player);

    expect(shop.claimDailyTopUp(player, now)).toBe(true);
    expect(energy.currentEnergy(player, now)).toBe(ENERGY.max);
    // Once per day, not once per request.
    expect(shop.claimDailyTopUp(player, now)).toBe(false);
    expect(shop.claimDailyTopUp(player, now + PASS.dayMs)).toBe(true);
  });

  it('gives a pass holder no extra keys', () => {
    // Tempo, never entries. This is the category boundary in one assertion.
    const player = makeVeteran(BUYER);
    const before = keys.balance(player.id).remaining;
    shop.fulfil(player, shop.itemFor('cyclepass')!, null);
    expect(keys.balance(player.id).remaining).toBe(before);
  });
});

describe('the Compass sells targeting', () => {
  it('cannot be aimed before it is owned', () => {
    expect(shop.aim(BUYER, 'some-hunt')).toBe(false);
    expect(shop.targetFor(BUYER)).toBeNull();
  });

  it('points hints at a chosen treasure', () => {
    const player = makePlayer(BUYER);
    const hunt = huntOfType('crack');
    shop.fulfil(player, shop.itemFor('compass')!, null);

    expect(shop.aim(player.id, hunt.id)).toBe(true);
    expect(shop.targetFor(player.id)).toBe(hunt.id);
  });

  it('overrides proximity, which is the thing being sold', () => {
    const zone = store.getZone('ridge')!;
    const live = store.liveHuntsIn(zone);
    const player = makePlayer(BUYER);

    // A treasure deliberately far from where the digging happens.
    const near = hints.nearestHunt(live, 0, 0);
    const far = live.find(h => h.id !== near.id)!;

    const aimed = hints.awardForReveal(zone.seedSecret, player.id, 0, 0, live, Date.now(), {
      guaranteed: true,
      targetHuntId: far.id,
    });
    expect(aimed!.huntId).toBe(far.id);

    // Without a target it goes back to whatever is nearest.
    const free = hints.awardForReveal(zone.seedSecret, player.id, 0, 1, live, Date.now(), {
      guaranteed: true,
    });
    expect(free!.huntId).toBe(hints.nearestHunt(live, 0, 1).id);
  });

  it('runs out after its charges and forgets the target', () => {
    const player = makePlayer(BUYER);
    const hunt = huntOfType('crack');
    shop.fulfil(player, shop.itemFor('compass')!, null);
    shop.aim(player.id, hunt.id);

    const charges = (shop.itemFor('compass')!.grant as { hints: number }).hints;
    for (let i = 0; i < charges; i++) shop.consumeCharge(player.id);

    expect(shop.targetFor(player.id)).toBeNull();
  });

  /**
   * The reason selling targeting is safe.
   *
   * The Crack ranks correct picks by hints HELD about the hunt, so five aimed
   * hints are five points of tiebreak debt. A player who bought their way to
   * the answer loses to one who did not — anti-pay-to-win rule 3, doing its
   * work without a special case anywhere in the shop.
   */
  it('costs the buyer the close ones', () => {
    const player = makePlayer(BUYER);
    const hunt = huntOfType('crack');
    const zone = store.getZone(hunt.zoneId)!;

    shop.fulfil(player, shop.itemFor('compass')!, null);
    shop.aim(player.id, hunt.id);

    const before = hints.countForHunt(player.id, hunt.id);
    for (let i = 0; i < 4; i++) {
      hints.awardForReveal(zone.seedSecret, player.id, i, i, store.liveHuntsIn(zone), Date.now(), {
        guaranteed: true,
        targetHuntId: hunt.id,
      });
    }
    // Every aimed hint is a point of tiebreak debt on the hunt it was aimed at.
    expect(hints.countForHunt(player.id, hunt.id)).toBeGreaterThan(before);
  });
});

describe('revenue is readable per SKU', () => {
  it('separates what sold, so the business thesis can be falsified', () => {
    // The claim is that targeting matters more than its ten cents suggests. A
    // single revenue counter could not tell us whether that is true.
    buy(BUYER, 'refill');
    buy(BUYER, 'refill');
    buy(BUYER, 'compass');

    const rows = shopRepo.revenueBySku(0);
    const bySku = Object.fromEntries(rows.map(r => [r.sku, r]));

    expect(bySku.refill!.orders).toBe(2);
    expect(bySku.refill!.cents).toBe(2 * shop.itemFor('refill')!.priceCents);
    expect(bySku.compass!.orders).toBe(1);
  });
});
