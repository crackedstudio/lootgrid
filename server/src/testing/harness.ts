import { closeDb, getDb, openDb } from '../db/index';
import { migrate } from '../db/migrate';
import * as agentRepo from '../db/repos/agents';
import * as attemptRepo from '../db/repos/attempts';
import * as hintRepo from '../db/repos/hints';
import * as huntRepo from '../db/repos/hunts';
import * as marketRepo from '../db/repos/market';
import * as nonceRepo from '../db/repos/nonces';
import * as playerRepo from '../db/repos/players';
import * as shopRepo from '../db/repos/shop';
import * as zoneRepo from '../db/repos/zones';
import * as escrowWorker from '../chain/escrow';
import * as ratelimit from '../ratelimit';
import * as hints from '../hints';
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
  // Every repo with a statement cache must be listed here. Forgetting one does
  // not fail loudly at the seam — it surfaces as "database connection is not
  // open" from whichever query happens to run first in the next test.
  for (const repo of [playerRepo, zoneRepo, huntRepo, attemptRepo, nonceRepo, hintRepo, marketRepo, agentRepo, shopRepo]) {
    repo.resetStatements();
  }
  store.resetForTests();
  ratelimit.reset();
  escrowWorker.reset();

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
 *
 * Salts are random, so a given world is not guaranteed to contain every game
 * type — roughly one run in a hundred used to seed no `tap` block and fail the
 * test for it. Reseeding until the type appears keeps the randomness (which is
 * the point — tests should not depend on one fixed salt) without the flake.
 */
export function huntOfType(type: GameType) {
  for (let attempt = 0; attempt < 25; attempt++) {
    for (const zone of store.listZones()) {
      for (const h of store.liveHuntsIn(zone)) {
        const full = store.getHunt(h.id)!;
        if (store.blockGame(full).type === type) return full;
      }
    }
    freshWorld();
  }
  throw new Error(`no seeded hunt is running "${type}" after 25 worlds`);
}

export function makePlayer(id: string, handle = `@${id}`) {
  return store.ensurePlayer(id, handle);
}

/**
 * A player who can actually enter a cash hunt.
 *
 * The money gate refuses brand-new accounts — that is the entire point of it —
 * so any test about *winning* has to start from someone who has already earned
 * the right to try. This satisfies the gate the honest way rather than
 * disabling it: it backdates the account, closes a hunt, and grants its
 * resolved hints across separate days. If the gate's rules change, tests using
 * this break loudly instead of quietly testing an open door.
 *
 * Deliberately not a flag on `mayEnter`. A test-only bypass in the admission
 * path is exactly the kind of thing that survives into production behind an env
 * var nobody audits.
 */
export function makeVeteran(id: string, handle = `@${id}`) {
  const player = makePlayer(id, handle);
  const now = Date.now();

  // Old enough to be past WALLET.minAgeMs. Written to both the row and the
  // cached object, because the referee reads the object.
  const born = now - 30 * DAY_MS;
  getDb().prepare('UPDATE players SET created_at = ? WHERE id = ?').run(born, id);
  player.createdAt = born;

  // A closed hunt's hints are what rank is computed from. A puzzle hunt, so
  // this never disturbs the cash hunt a test is about.
  const zone = store.listZones()[0]!;
  const closing = store.liveHuntsIn(zone).find(h => h.kind === 'puzzle');
  if (closing) {
    const hunt = store.getHunt(closing.id)!;
    const pool = hints.forHunt(hunt);
    store.setHuntStatus(hunt, 'expired', null, now);
    // Spread across distinct UTC days — the part of the gate that time buys and
    // money cannot.
    pool.forEach((h, i) => {
      hintRepo.grant(id, h.id, 'reveal', born + i * DAY_MS);
    });
    store.evictHunt(hunt.id);
  }

  return player;
}

const DAY_MS = 24 * 60 * 60 * 1000;
