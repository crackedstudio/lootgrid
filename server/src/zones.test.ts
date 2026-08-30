import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from './env';
import * as store from './store';
import { freshWorld, teardownWorld } from './testing/harness';

/**
 * How many agent zones this deployment runs.
 *
 * The count is an economy decision wearing a config flag: each agent zone
 * carries `AGENT_CASH_PER_ZONE` live cash hunts, so raising it by one is four
 * more prizes the treasury funds whether or not anybody turns up. Which is
 * exactly why it should be changeable without a commit — and why the change has
 * to work on a database that already has players in it, not only on a fresh one.
 */

const mut = env as { AGENT_ZONE_COUNT: number };
const original = mut.AGENT_ZONE_COUNT;

const agentZones = () => store.listZones().filter(z => z.kind === 'agent');

beforeEach(() => {
  mut.AGENT_ZONE_COUNT = original;
  freshWorld();
});
afterEach(() => {
  mut.AGENT_ZONE_COUNT = original;
  teardownWorld();
});

describe('agent zone count', () => {
  it('runs one agent zone by default, leaving today’s outflow unchanged', () => {
    expect(agentZones().map(z => z.id)).toEqual(['lattice']);
  });

  it('always keeps every human zone', () => {
    expect(store.listZones().filter(z => z.kind === 'human')).toHaveLength(4);
  });

  it('adds zones to a world that already exists', () => {
    // The property that makes it a dial rather than a constant. Seeding only on
    // an empty world would mean raising the count did nothing until somebody
    // dropped the database — and the deployment that matters is the one with
    // players in it.
    expect(agentZones()).toHaveLength(1);

    mut.AGENT_ZONE_COUNT = 3;
    store.bootstrap();

    expect(agentZones().map(z => z.id)).toEqual(['lattice', 'foundry', 'kiln']);
  });

  it('does not disturb a zone it has already seeded', () => {
    const before = store.getZone('lattice')!;

    mut.AGENT_ZONE_COUNT = 4;
    store.bootstrap();

    const after = store.getZone('lattice')!;
    // Same epoch, same commitment, same rotation clock. A zone appearing beside
    // it must not reset the map people are playing.
    expect(after.epoch).toBe(before.epoch);
    expect(after.seedCommit).toBe(before.seedCommit);
    expect(after.rotatesAt).toBe(before.rotatesAt);
  });

  it('is idempotent — booting twice on an unchanged count adds nothing', () => {
    store.bootstrap();
    store.bootstrap();
    expect(agentZones()).toHaveLength(1);
  });

  it('leaves existing zones alone when the count is lowered', () => {
    mut.AGENT_ZONE_COUNT = 3;
    store.bootstrap();
    expect(agentZones()).toHaveLength(3);

    // Lowering stops seeding; it never deletes. A zone removed while holding
    // live hunts would strand every prize in it.
    mut.AGENT_ZONE_COUNT = 1;
    store.bootstrap();
    expect(agentZones()).toHaveLength(3);
  });

  it('stocks every agent zone it seeds', () => {
    mut.AGENT_ZONE_COUNT = 2;
    store.bootstrap();

    for (const zone of agentZones()) {
      expect(store.liveHuntsIn(zone).length).toBeGreaterThan(0);
    }
  });
});
