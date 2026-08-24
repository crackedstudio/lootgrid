import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from './appTypes';
import { ENERGY } from './config';
import { getDb } from './db/index';
import * as playerRepo from './db/repos/players';
import * as energy from './energy';
import * as funnel from './funnel';
import { wireObservers } from './observability';
import { registerRoutes } from './http';
import * as metrics from './metrics';
import * as referee from './referee';
import * as shop from './shop';
import * as store from './store';
import { freshWorld, huntOfType, makePlayer, makeVeteran, teardownWorld } from './testing/harness';

/**
 * The five numbers.
 *
 * The failure mode instrumentation actually has is not being wrong — it is
 * silently reading zero, which looks exactly like a healthy system with no
 * traffic. Every test here therefore checks that a metric MOVED in response to
 * something a player did, not merely that it exists.
 */

const DAY = 86_400_000;

let app: App;

beforeEach(async () => {
  freshWorld();
  metrics.registry.resetMetrics();
  // The observers are wired at the process entry point in production. Without
  // this the funnel metrics read zero in every test while passing — which is
  // exactly the failure this file exists to catch.
  wireObservers();
  app = Fastify({ logger: false }) as unknown as App;
  registerRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  referee.stop();
  funnel.stop();
  teardownWorld();
});

/**
 * One sample's value, by its full Prometheus name.
 *
 * A histogram is exported under its BASE name in the JSON, with `_count`,
 * `_sum` and `_bucket` appearing as `metricName` on the individual samples —
 * so looking a series up by `m.name` alone silently finds nothing and reads as
 * a metric that never fired. Which is exactly the failure this file is about.
 */
const valueOf = async (name: string, labels: Record<string, string> = {}) => {
  const all = await metrics.registry.getMetricsAsJSON();
  for (const metric of all) {
    for (const v of metric.values ?? []) {
      const sampleName = (v as { metricName?: string }).metricName ?? metric.name;
      if (sampleName !== name) continue;
      if (Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val)) {
        return v.value;
      }
    }
  }
  return 0;
};

describe('1. taps to first treasure', () => {
  it('takes one sample when a player first reaches a hunt', async () => {
    const player = makeVeteran('0xtaps');
    const zone = store.getZone('ridge')!;

    // Six digs, then a hunt.
    for (let i = 0; i < 6; i++) {
      store.addReveal(zone, {
        r: i,
        c: 0,
        type: 'empty',
        byHandle: player.handle,
        at: Date.now(),
        playerId: player.id,
      });
    }
    referee.openAttempt(player, huntOfType('crack'));

    expect(await valueOf('lootgrid_taps_to_first_treasure_count')).toBe(1);
    expect(await valueOf('lootgrid_taps_to_first_treasure_sum')).toBe(6);
  });

  /**
   * One sample per PLAYER, ever — not per attempt.
   *
   * The number answers "how much did it cost you to find your first treasure",
   * so a second sample from the same person would be answering a different
   * question into the same histogram.
   */
  it('never samples the same player twice', () => {
    const player = makeVeteran('0xonce');
    referee.openAttempt(player, huntOfType('crack'));
    const zone = store.getZone('ridge')!;
    const another = store.liveHuntsIn(zone).find(h => h.kind === 'puzzle')!;
    referee.openAttempt(player, store.getHunt(another.id)!);

    return expect(valueOf('lootgrid_taps_to_first_treasure_count')).resolves.toBe(1);
  });
});

describe('2. hints held at entry', () => {
  it('records how many, not merely whether', async () => {
    // The yes/no version has existed since phase 1 and could not tell one hint
    // from three — and three about one treasure is what the economy is priced
    // around.
    const player = makeVeteran('0xhints');
    referee.openAttempt(player, huntOfType('crack'));

    expect(await valueOf('lootgrid_hints_held_at_entry_count', { kind: 'cash' })).toBe(1);
  });
});

describe('3. energy-empty moments', () => {
  it('counts a refusal, labelled by what was being attempted', async () => {
    const player = makePlayer('0xflat');
    const now = Date.now();
    player.energyValue = 0;
    player.energyAt = now;

    expect(energy.spend(player, ENERGY.costFog, now, 'dig').ok).toBe(false);
    expect(await valueOf('lootgrid_energy_empty_total', { action: 'dig' })).toBe(1);
    // "Stopped mid-dig" and "could not afford a survey" are different problems.
    expect(await valueOf('lootgrid_energy_empty_total', { action: 'survey' })).toBe(0);
  });

  it('does not count a spend that succeeded', async () => {
    const player = makePlayer('0xrich');
    energy.spend(player, 1, Date.now(), 'dig');
    expect(await valueOf('lootgrid_energy_empty_total', { action: 'dig' })).toBe(0);
  });
});

describe('4. day-1 and day-7 return', () => {
  /** A player created `age` days ago, seen on each of `activeOffsets`. */
  function cohortPlayer(id: string, ageDays: number, activeOffsets: number[]): void {
    makePlayer(id);
    const born = Date.now() - ageDays * DAY;
    getDb().prepare('UPDATE players SET created_at = ? WHERE id = ?').run(born, id);
    for (const off of activeOffsets) playerRepo.seen(id, born + off * DAY);
  }

  it('counts a player who came back the next day', () => {
    cohortPlayer('0xreturned', 3, [0, 1]);
    const d1 = funnel.retention(1);
    expect(d1.eligible).toBeGreaterThanOrEqual(1);
    expect(d1.returned).toBe(1);
  });

  it('does not count one who never came back', () => {
    cohortPlayer('0xgone', 3, [0]);
    expect(funnel.retention(1).returned).toBe(0);
  });

  /**
   * The mistake that makes retention dashboards untrustworthy.
   *
   * Someone who joined this morning has not *failed* to return on day 7 — they
   * have not had the chance. Counting them as a miss drags every number toward
   * zero and makes a healthy game look like a dying one.
   */
  it('excludes players whose day has not arrived yet', () => {
    cohortPlayer('0xtoday', 0, [0]);
    const d7 = funnel.retention(7);
    expect(d7.eligible).toBe(0);
    // And with nobody eligible, the ratio is zero rather than a divide by zero.
    expect(d7.ratio).toBe(0);
  });

  it('publishes the ratio as a gauge', async () => {
    cohortPlayer('0xa', 3, [0, 1]);
    cohortPlayer('0xb', 3, [0]);
    funnel.refresh();
    expect(await valueOf('lootgrid_retention_ratio', { day: '1' })).toBeCloseTo(0.5, 5);
  });
});

describe('5. share of players who pay', () => {
  it('is zero before anybody buys anything', () => {
    makePlayer('0xbroke');
    expect(funnel.paying().ratio).toBe(0);
  });

  it('counts a player once however much they buy', () => {
    // "Ever paid" rather than "paid this month": the question at this stage is
    // whether the rails work on this audience at all, not how often.
    const player = makePlayer('0xpayer');
    makePlayer('0xfree');

    shop.fulfil(player, shop.itemFor('refill')!, null);
    shop.fulfil(player, shop.itemFor('compass')!, null);

    const pay = funnel.paying();
    expect(pay.payingPlayers).toBe(1);
    expect(pay.players).toBe(2);
    expect(pay.ratio).toBeCloseTo(0.5, 5);
  });

  it('publishes it as a gauge', async () => {
    shop.fulfil(makePlayer('0xp1'), shop.itemFor('refill')!, null);
    makePlayer('0xp2');
    funnel.refresh();

    expect(await valueOf('lootgrid_paying_players_ratio')).toBeCloseTo(0.5, 5);
    expect(await valueOf('lootgrid_players_total', { paid: 'yes' })).toBe(1);
    expect(await valueOf('lootgrid_players_total', { paid: 'no' })).toBe(1);
  });
});

describe('activity is recorded once a day, not once a request', () => {
  it('marks the day the first time and skips it after', () => {
    const player = makePlayer('0xactive');
    const now = Date.now();

    store.markSeen(player, now);
    store.markSeen(player, now + 1000);
    store.markSeen(player, now + 2000);

    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM player_days WHERE player_id = ?')
      .get(player.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('marks a second day when one arrives', () => {
    const player = makePlayer('0xtomorrow');
    const now = Date.now();
    store.markSeen(player, now);
    store.markSeen(player, now + DAY);

    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM player_days WHERE player_id = ?')
      .get(player.id) as { n: number };
    expect(rows.n).toBe(2);
  });

  it('is recorded for any authenticated request, not only instrumented routes', async () => {
    // A funnel that only counts players who happened to hit an instrumented
    // endpoint is measuring the endpoint.
    await app.inject({ method: 'GET', url: '/me', headers: { 'x-player': '0xvisitor' } });

    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM player_days WHERE player_id = ?')
      .get('0xvisitor') as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('the report reads as one thing', () => {
  it('serves all five together', async () => {
    const res = await app.inject({ method: 'GET', url: '/debug/funnel' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body).toHaveProperty('players');
    expect(body).toHaveProperty('payingRatio');
    expect(body.retention.map((r: { day: number }) => r.day)).toEqual([1, 7]);
    // A stale funnel read as fresh is worse than no funnel.
    expect(body.at).toBeGreaterThan(0);
  });
});
