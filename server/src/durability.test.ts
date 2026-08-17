import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as attemptRepo from './db/repos/attempts';
import { MODULES } from './games';
import type { DeductionState } from './games/deduction';
import * as store from './store';
import { freshWorld, makePlayer, teardownWorld } from './testing/harness';
import type { Attempt } from './types';

/**
 * Surviving a deploy.
 *
 * A six-second attempt spanning a restart is nobody's loss — nobody is mid-tap
 * across a deploy, and the clock it was racing is gone anyway. A ten-minute
 * agent attempt is different: the player is owed the rest of it, and losing
 * those on every release would mean the async clock works only between deploys,
 * which is not a clock.
 *
 * So the rule is split by module, and these tests are about the split holding
 * in both directions — because the failure modes are opposite. Forget to
 * persist and agents lose attempts they paid for; persist everything and the
 * reflex loop takes a disk write per tap.
 */

const PLAYER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b0';

beforeEach(() => freshWorld());
afterEach(() => teardownWorld());

/** An attempt row, written straight to storage the way the referee would. */
function seedAttempt(over: Partial<Attempt> = {}, who = PLAYER): Attempt {
  const zone = store.listZones()[0]!;
  const hunt = store.liveHuntsIn(zone)[0]!;
  const player = makePlayer(who, '@agent');

  const attempt: Attempt = {
    id: `at_${Math.random().toString(16).slice(2, 10)}`,
    huntId: hunt.id,
    playerId: player.id,
    handle: player.handle,
    gameType: 'deduction',
    startedAt: Date.now(),
    deadlineAt: Date.now() + 10 * 60_000,
    status: 'active',
    lastSeq: 0,
    state: null,
    elapsedMs: null,
    hintsUsed: null,
    failReason: null,
    progress: 0,
    intervals: [],
    events: [],
    maxClockSkewMs: 0,
    ...over,
  };
  store.addAttempt(attempt);
  return attempt;
}

describe('which modules are durable', () => {
  it('marks the agent games durable and the reflex games not', () => {
    // The reflex loop is the one path that cannot afford a disk write per
    // input, and the one whose state is worthless a second later.
    expect(MODULES.deduction.durable).toBe(true);
    expect(MODULES.negotiation.durable).toBe(true);
    expect(MODULES.search.durable).toBe(true);

    for (const type of ['tap', 'math', 'sequence', 'memory'] as const) {
      expect(MODULES[type].durable).toBeFalsy();
    }
  });
});

describe('a long attempt survives a restart', () => {
  it('comes back with its reasoning intact', () => {
    const attempt = seedAttempt();
    // Three probes in: the whole value of the attempt is in these answers.
    attempt.state = {
      used: 3,
      answers: [
        { payload: { kind: 'region', quadrant: 'NW' }, answer: true },
        { payload: { kind: 'parity', parity: 'even' }, answer: false },
        { payload: { kind: 'rowBand', from: 0, to: 4 }, answer: true },
      ],
      solved: false,
    } satisfies DeductionState;
    attempt.lastSeq = 3;
    attempt.progress = 62;
    store.saveAttemptState(attempt);

    // The restart: everything in memory is gone.
    store.resetForTests();
    store.bootstrap();

    const back = store.getAttempt(attempt.id);
    expect(back).toBeDefined();
    expect(back!.status).toBe('active');
    // Not merely present — usable. An attempt that came back without its
    // answers would be worse than one that was abandoned, because the player
    // would spend the rest of their budget rediscovering them.
    expect((back!.state as DeductionState).answers).toHaveLength(3);
    expect((back!.state as DeductionState).used).toBe(3);
    expect(back!.lastSeq).toBe(3);
    expect(back!.progress).toBe(62);
  });

  it('is handed to the referee so its deadline is enforced again', () => {
    const attempt = seedAttempt();
    attempt.state = { used: 1, answers: [], solved: false } satisfies DeductionState;
    store.saveAttemptState(attempt);

    store.resetForTests();
    store.bootstrap();

    // A resumed attempt with nobody watching its deadline would run forever.
    const recovered = store.takeRecovered();
    expect(recovered.map(a => a.id)).toContain(attempt.id);
    // Taken once: a second boot must not resurrect the same list.
    expect(store.takeRecovered()).toHaveLength(0);
  });

  it('keeps the player in the hunt they paid to enter', () => {
    const attempt = seedAttempt();
    attempt.state = { used: 2, answers: [], solved: false } satisfies DeductionState;
    store.saveAttemptState(attempt);

    store.resetForTests();
    store.bootstrap();

    // `attemptOf` is what stops a second entry to the same hunt. If recovery
    // missed this index, the player could re-enter and pay twice.
    expect(store.attemptOf(attempt.huntId, PLAYER)?.id).toBe(attempt.id);
  });
});

describe('a short attempt does not', () => {
  it('is abandoned, as it always was', () => {
    // No state was ever written, which is exactly how a reflex attempt looks.
    const attempt = seedAttempt({ gameType: 'tap' });

    store.resetForTests();
    store.bootstrap();

    const back = attemptRepo.get(attempt.id);
    expect(back?.status).toBe('abandoned');
    expect(back?.failReason).toBe('server_restart');
    expect(store.takeRecovered()).toHaveLength(0);
  });

  it('does not drag a durable attempt down with it', () => {
    // Both in flight across the same restart. The sweep must not be indiscriminate.
    // Different players: one shot per player per block is enforced in storage.
    const reflex = seedAttempt({ gameType: 'tap' }, PLAYER);
    const agent = seedAttempt({ gameType: 'search' }, OTHER);
    agent.state = { used: 1, r: 3, c: 4, best: 5, caught: false };
    store.saveAttemptState(agent);

    store.resetForTests();
    store.bootstrap();

    expect(attemptRepo.get(reflex.id)?.status).toBe('abandoned');
    expect(attemptRepo.get(agent.id)?.status).toBe('active');
  });
});

describe('the snapshot never breaks play', () => {
  it('swallows a storage failure rather than failing the input', () => {
    const attempt = seedAttempt();
    attempt.state = { used: 1, answers: [], solved: false } satisfies DeductionState;

    // Closed database: the attempt is still valid in memory and playing on. A
    // failed snapshot costs resumability after a restart that may never happen;
    // failing the input costs the player their turn for certain.
    teardownWorld();
    expect(() => store.saveAttemptState(attempt)).not.toThrow();
    freshWorld();
  });
});
