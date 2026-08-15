import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from './appTypes';
import { MODULES } from './games';
import { tileType } from './grid';
import { registerRoutes } from './http';
import * as referee from './referee';
import * as store from './store';
import { freshWorld, huntOfType, makePlayer, teardownWorld } from './testing/harness';
import type { GameType } from './types';

/**
 * The map must not be reconstructible by anyone holding the client.
 *
 * The original prototype computed tile types from coordinates alone, in code
 * that shipped in the browser bundle — so every treasure location was readable
 * from devtools. These tests exist so that can never quietly come back.
 */

const PLAYER = '0x00000000000000000000000000000000000000aa';

function buildApp(): App {
  const app = Fastify({ logger: false }) as unknown as App;
  registerRoutes(app);
  return app;
}

describe('map secrecy', () => {
  let app: App;

  beforeEach(async () => {
    freshWorld();
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    referee.stop();
    teardownWorld();
  });

  it('derives tile types from a secret seed, not from coordinates', () => {
    const [a, b] = store.listZones();
    // Same coordinates, different zones: if the type matched, the fog would be a
    // pure function of (r,c) and publishing the algorithm would publish the map.
    let differences = 0;
    for (let r = 0; r < 18; r++) {
      for (let c = 0; c < 12; c++) {
        if (tileType(a!, r, c) !== tileType(b!, r, c)) differences += 1;
      }
    }
    expect(differences).toBeGreaterThan(50);
  });

  it('uses a high-entropy seed', () => {
    // 32 bytes. Publishing the hashing algorithm is safe; brute force is not.
    for (const zone of store.listZones()) {
      expect(zone.seedSecret).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('never serves the seed secret from any zone endpoint', async () => {
    for (const path of ['/zones', '/zones/ridge/grid', '/audit/zones/ridge']) {
      const res = await app.inject({ method: 'GET', url: path, headers: { 'x-player': PLAYER } });
      const secrets = store.listZones().map(z => z.seedSecret);
      for (const secret of secrets) {
        expect(res.body).not.toContain(secret);
      }
      expect(res.body).not.toContain('seedSecret');
    }
  });

  it('publishes a commit to the seed, so the map can be audited later', async () => {
    const res = await app.inject({ method: 'GET', url: '/zones' });
    const { zones } = res.json() as { zones: Array<{ seedCommit: string }> };
    for (const z of zones) expect(z.seedCommit).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns no unrevealed cells in the grid', async () => {
    const res = await app.inject({ method: 'GET', url: '/zones/ridge/grid' });
    const grid = res.json() as { cols: number; rows: number; reveals: unknown[] };
    // A fresh zone has nothing uncovered, so the payload must describe nothing.
    expect(grid.reveals).toHaveLength(0);
    expect(grid.cols * grid.rows).toBeGreaterThan(0);
  });

  it('reveals a cell only after somebody spends energy on it', async () => {
    const before = await app.inject({ method: 'GET', url: '/zones/ridge/grid' });
    expect((before.json() as { reveals: unknown[] }).reveals).toHaveLength(0);

    await app.inject({
      method: 'POST',
      url: '/zones/ridge/tiles/4/4/open',
      headers: { 'x-player': PLAYER },
    });

    const after = await app.inject({ method: 'GET', url: '/zones/ridge/grid' });
    const reveals = (after.json() as { reveals: Array<{ r: number; c: number }> }).reveals;
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ r: 4, c: 4 });
  });

  it('never serves a live hunt salt', async () => {
    const salts = store
      .listZones()
      .flatMap(z => store.liveHuntsIn(z))
      .map(h => h.salt);
    expect(salts.length).toBeGreaterThan(0);

    for (const path of ['/zones/ridge/grid', `/hunts/${store.liveHuntsIn(store.listZones()[0]!)[0]!.id}`]) {
      const res = await app.inject({ method: 'GET', url: path, headers: { 'x-player': PLAYER } });
      for (const salt of salts) expect(res.body).not.toContain(salt);
    }
  });

  it('does not leak the block game through the debug endpoint', async () => {
    const hunt = huntOfType('math');
    const res = await app.inject({ method: 'GET', url: `/debug/hunts/${hunt.id}` });
    const body = res.body;
    expect(body).not.toContain('answer');
    expect(body).not.toContain(hunt.salt);
    // The type alone is fine; the spec and secret are not.
    expect(res.json()).toHaveProperty('gameType');
  });
});

describe('game secrecy', () => {
  beforeEach(() => freshWorld());
  afterEach(() => {
    referee.stop();
    teardownWorld();
  });

  it('never returns the secret through publicSpec', () => {
    for (const [type, mod] of Object.entries(MODULES)) {
      const { spec, secret } = mod.generate('a-salt', 'med');
      const pub = JSON.stringify(mod.publicSpec(spec, secret));
      if (secret !== null) {
        // Math is the only module with a secret, and it must survive this.
        expect(pub).not.toContain(JSON.stringify(secret));
      }
      expect(pub, `${type} leaked an answer`).not.toContain('"answer"');
    }
  });

  it('sends math one question at a time, without answers', () => {
    const hunt = huntOfType('math');
    const res = referee.openAttempt(makePlayer('0xmath'), hunt);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const spec = res.spec as { count: number; index: number; question: { q: string } };
    const game = store.blockGame(hunt);
    const secret = game.secret as { ladder: Array<Array<{ q: string; answer: number }>> };
    const baseRung = (game.spec as { baseRung: number }).baseRung;

    expect(spec.index).toBe(0);
    expect(spec.question.q).toBe(secret.ladder[0]![baseRung]!.q);

    // The Director's ladder made the secret five times larger, so this now has
    // five times as much to keep back: not just later rounds, but every rung of
    // this one the player was not served. A leaked rung is a leaked answer for
    // whichever round the Director happens to pick next.
    const sent = JSON.stringify(spec);
    for (const [round, rungs] of secret.ladder.entries()) {
      for (const [rung, q] of rungs.entries()) {
        if (round === 0 && rung === baseRung) continue;
        if (q.q === spec.question.q) continue; // two rungs can coincide
        expect(sent, `round ${round} rung ${rung} leaked`).not.toContain(q.q);
      }
    }
    expect(sent).not.toContain('answer');
  });

  it('keeps memory off cash blocks, where the client must know the answer', () => {
    // Memory has to send its sequence to be played back, so it is the easiest
    // to automate — it may only ever guard XP.
    const cashGames = new Set<GameType>();
    for (const zone of store.listZones()) {
      for (const h of store.liveHuntsIn(zone)) {
        const hunt = store.getHunt(h.id)!;
        if (hunt.kind === 'cash') cashGames.add(store.blockGame(hunt).type);
      }
    }
    expect(cashGames.has('memory')).toBe(false);
  });
});
