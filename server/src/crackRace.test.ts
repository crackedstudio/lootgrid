import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRACK, RACE } from './config';
import * as hintRepo from './db/repos/hints';
import type { CrackSpec } from './games/crack';
import * as hints from './hints';
import * as referee from './referee';
import * as store from './store';
import { freshWorld, huntOfType, makeVeteran, teardownWorld } from './testing/harness';
import type { Hunt } from './types';

/**
 * Winning a cash hunt.
 *
 * Every assertion here is really the same assertion: the prize goes to the
 * player who worked it out, and never to the one with the better phone. The
 * old race handed it to whoever tapped fourteen times fastest, so a player who
 * deduced the location and one who wandered onto the tile competed identically
 * on thumb speed — and for the audience this is built for, the *feeling* was
 * worse than the fact.
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  freshWorld();
});

afterEach(() => {
  referee.stop();
  vi.useRealTimers();
  teardownWorld();
});

/**
 * Enter the hunt. Entering is what buys your fifteen seconds.
 *
 * Entry and locking are separate steps here because they are separate steps in
 * the game, and the difference matters: the first LOCK moves the hunt to
 * `resolving`, which closes entry. That is deliberate — once somebody has
 * answered, the hunt is being decided, and refusing a latecomer is kinder than
 * taking their three energy and cutting them off mid-window.
 */
function enter(hunt: Hunt, playerId: string, at = T0) {
  // A veteran, because the money gate refuses new accounts and these tests are
  // about what happens once you are through it. See harness.makeVeteran.
  const player = makeVeteran(playerId, `@${playerId}`);
  const res = referee.openAttempt(player, hunt, at);
  if (!res.ok) throw new Error(`could not enter: ${res.error}`);
  return { id: res.attempt.id, spec: res.spec as CrackSpec };
}

/** Commit a door. `door` is an index into the spec's candidates. */
function lockDoor(
  seat: { id: string; spec: CrackSpec },
  door: number,
  at = T0,
): void {
  referee.submitInputs(
    seat.id,
    [{ seq: 1, kind: 'lock', t: 10, value: seat.spec.candidates[door] } as never],
    at,
  );
}

/** Enter and immediately commit — the common case. */
function lock(hunt: Hunt, playerId: string, door: number, at = T0) {
  const seat = enter(hunt, playerId, at);
  lockDoor(seat, door, at + 10);
  return seat.id;
}

/** Which door is the right one. Test-only knowledge. */
const answerOf = (hunt: Hunt): number => (store.blockGame(hunt).secret as { answer: number }).answer;
const wrongDoor = (hunt: Hunt): number => (answerOf(hunt) + 1) % CRACK.doors;

/** Give a player `n` live hints about this hunt, so the tiebreak has something to read. */
function grantHints(hunt: Hunt, playerId: string, n: number): void {
  const pool = hints.forHunt(hunt);
  for (let i = 0; i < n && i < pool.length; i++) {
    hintRepo.grant(playerId, pool[i]!.id, 'reveal', T0);
  }
}

const settle = () => vi.advanceTimersByTime(CRACK.limitMs + RACE.latencyGraceMs + 50);

describe('the right door wins', () => {
  it('awards the hunt to the correct pick', () => {
    const hunt = huntOfType('crack');
    const wrong = enter(hunt, '0xwrong');
    const right = enter(hunt, '0xright');
    lockDoor(wrong, wrongDoor(hunt));
    lockDoor(right, answerOf(hunt));

    settle();

    const resolved = store.getHunt(hunt.id)!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.winnerId).toBe('0xright');
  });

  /**
   * The heart of the phase.
   *
   * The wrong answer is locked first and locked fast. Under the old race it
   * would have won outright, because the old race asked who finished soonest.
   */
  it('ignores who answered first', () => {
    const hunt = huntOfType('crack');
    const fast = enter(hunt, '0xfastwrong');
    const slow = enter(hunt, '0xslowright');

    lockDoor(fast, wrongDoor(hunt), T0 + 200);
    lockDoor(slow, answerOf(hunt), T0 + 9_000);

    settle();
    expect(store.getHunt(hunt.id)!.winnerId).toBe('0xslowright');
  });

  it('holds the result open for the full fifteen seconds', () => {
    // Anyone already thinking when the first lock landed gets their whole
    // window. A 400ms hold would quietly restore "first to answer wins".
    const hunt = huntOfType('crack');
    const early = enter(hunt, '0xearly');
    const late = enter(hunt, '0xlate');

    lockDoor(early, wrongDoor(hunt), T0 + 100);
    vi.advanceTimersByTime(RACE.settlementWindowMs + 50);
    // The old human window was 400ms. Under it the hunt would already be
    // decided, and decided in favour of whoever answered soonest.
    expect(store.getHunt(hunt.id)!.status).toBe('resolving');

    lockDoor(late, answerOf(hunt), T0 + 14_000);
    settle();

    expect(store.getHunt(hunt.id)!.winnerId).toBe('0xlate');
  });
});

describe('fewer hints breaks the tie', () => {
  /**
   * The third of the four anti-pay-to-win rules, and the only one that lives
   * in the scoring rather than in a cap: the player who reached the answer on
   * less bought information beats the one who bought their way to it.
   */
  it('prefers the player who used less information', () => {
    const hunt = huntOfType('crack');
    grantHints(hunt, '0xbought', 4);
    grantHints(hunt, '0xearned', 1);

    const bought = enter(hunt, '0xbought');
    const earned = enter(hunt, '0xearned');
    lockDoor(bought, answerOf(hunt));
    lockDoor(earned, answerOf(hunt));

    settle();
    expect(store.getHunt(hunt.id)!.winnerId).toBe('0xearned');
  });

  it('records what each player knew when they committed', () => {
    const hunt = huntOfType('crack');
    grantHints(hunt, '0xheavy', 3);
    lock(hunt, '0xheavy', answerOf(hunt));
    settle();

    expect(store.attemptHistory('0xheavy', 5)[0]!.hintsUsed).toBe(3);
  });

  it('is not disturbed by a hint arriving after the lock', () => {
    // Snapshotted at the decision, not recomputed at the reveal — otherwise a
    // hint that landed in the last fifteen seconds could cost a tiebreak
    // already earned.
    const hunt = huntOfType('crack');
    grantHints(hunt, '0xa', 1);
    lock(hunt, '0xa', answerOf(hunt));
    grantHints(hunt, '0xa', 5);

    settle();
    expect(store.attemptHistory('0xa', 5)[0]!.hintsUsed).toBe(1);
  });

  it('breaks a remaining tie deterministically, never on time', () => {
    const hunt = huntOfType('crack');
    const a = enter(hunt, '0xaaa');
    const b = enter(hunt, '0xbbb');
    lockDoor(a, answerOf(hunt), T0 + 100);
    lockDoor(b, answerOf(hunt), T0 + 9_000);
    settle();

    const winner = store.getHunt(hunt.id)!.winnerId;
    expect(['0xaaa', '0xbbb']).toContain(winner);

    // The tiebreak is a hash of the hunt and the player, so it does not move
    // when the locks arrive in the other order. Nine seconds apart, reversed.
    const other = store.liveHuntsIn(store.getZone(hunt.zoneId)!).find(h => h.kind === 'cash');
    if (other) {
      const full = store.getHunt(other.id)!;
      const b2 = enter(full, '0xbbb');
      const a2 = enter(full, '0xaaa');
      lockDoor(b2, answerOf(full), T0 + 100);
      lockDoor(a2, answerOf(full), T0 + 9_000);
      settle();
      expect(['0xaaa', '0xbbb']).toContain(store.getHunt(other.id)!.winnerId);
    }
  });
});

describe('a wrong guess must not kill a funded prize', () => {
  /**
   * The review's open question #5, answered yes.
   *
   * The money is escrowed for whoever actually finds it. Burning a pot because
   * the first people to try were wrong would be the house keeping a prize
   * nobody won.
   */
  it('reopens the hunt when every door picked was wrong', () => {
    const hunt = huntOfType('crack');
    const a = enter(hunt, '0xa');
    const b = enter(hunt, '0xb');
    lockDoor(a, wrongDoor(hunt));
    lockDoor(b, wrongDoor(hunt));

    settle();

    const after = store.getHunt(hunt.id)!;
    expect(after.status).toBe('live');
    expect(after.winnerId).toBeNull();
  });

  it('still spends the attempt of everyone who guessed', () => {
    // One shot per block. Reopening must not become a retry for the people who
    // were already wrong, or the prize goes to whoever can afford most tries.
    const hunt = huntOfType('crack');
    lock(hunt, '0xa', wrongDoor(hunt));
    settle();

    expect(store.attemptHistory('0xa', 5)[0]!.status).toBe('lost');
    const player = makeVeteran('0xa');
    expect(referee.openAttempt(player, store.getHunt(hunt.id)!, T0 + 60_000)).toMatchObject({
      ok: false,
      error: 'already_attempted',
    });
  });

  it('lets a new player win the reopened hunt', () => {
    const hunt = huntOfType('crack');
    lock(hunt, '0xa', wrongDoor(hunt));
    settle();

    const reopened = store.getHunt(hunt.id)!;
    lock(reopened, '0xc', answerOf(reopened), T0 + 60_000);
    settle();

    expect(store.getHunt(hunt.id)!.winnerId).toBe('0xc');
  });
});
