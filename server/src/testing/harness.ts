import { closeDb, openDb } from '../db/index';
import { migrate } from '../db/migrate';
import * as attemptRepo from '../db/repos/attempts';
import * as huntRepo from '../db/repos/hunts';
import * as nonceRepo from '../db/repos/nonces';
import * as playerRepo from '../db/repos/players';
import * as zoneRepo from '../db/repos/zones';
import * as ratelimit from '../ratelimit';
import * as store from '../store';
import type { GameType } from '../types';

/**
 * A clean world per test.
 *
 * Prepared statements are bound to a specific database handle, so every repo's
 * cache has to be dropped alongside the connection — otherwise the second test
 * in a file queries a closed database.
 */
export function freshWorld(): void {
  closeDb();
  for (const repo of [playerRepo, zoneRepo, huntRepo, attemptRepo, nonceRepo]) {
    repo.resetStatements();
  }
  store.resetForTests();
  ratelimit.reset();

  openDb(':memory:');
  migrate();
  store.bootstrap();
}

export function teardownWorld(): void {
  closeDb();
  ratelimit.reset();
}

/** First live hunt in the first zone — the block most tests race on. */
export function anyHunt() {
  const zone = store.listZones()[0]!;
  const hunt = store.liveHuntsIn(zone)[0];
  if (!hunt) throw new Error('no live hunt seeded');
  return store.getHunt(hunt.id)!;
}

/**
 * Game type is derived from each block's salt, so seeded hunts get a mix.
 * Tests that exercise one game have to go and find a block running it.
 */
export function huntOfType(type: GameType) {
  for (const zone of store.listZones()) {
    for (const h of store.liveHuntsIn(zone)) {
      const full = store.getHunt(h.id)!;
      if (store.blockGame(full).type === type) return full;
    }
  }
  throw new Error(`no seeded hunt is running "${type}"`);
}

export function makePlayer(id: string, handle = `@${id}`) {
  return store.ensurePlayer(id, handle);
}
