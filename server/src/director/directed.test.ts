import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as director from '.';
import { mathModule, type MathSecret, type MathSpec, type MathState } from '../games/math';
import * as referee from '../referee';
import * as store from '../store';
import { freshWorld, huntOfType, makePlayer, teardownWorld } from '../testing/harness';
import type { Attempt, Hunt } from '../types';
import { stateSchema } from './types';

/**
 * The Director reaching a game.
 *
 * Phase 8 built a Director that chose rounds, hashed them into a transcript, and
 * was called by nothing — a component whose tests all passed while it had no
 * effect on any hunt anybody played. These tests are about the wire, so every
 * one of them goes through the real referee rather than calling the module
 * directly. A unit test of `directiveFor` is exactly what failed to notice.
 */

const attemptFor = (hunt: Hunt, wallet: string): { attempt: Attempt; spec: any } => {
  const res = referee.openAttempt(makePlayer(wallet), hunt);
  if (!res.ok) throw new Error(`could not open attempt: ${res.error}`);
  return { attempt: res.attempt, spec: res.spec };
};

/** The answer to whatever question this attempt is currently looking at. */
function answerFor(hunt: Hunt, attempt: Attempt): number {
  const game = store.blockGame(hunt);
  const spec = game.spec as MathSpec;
  const secret = game.secret as MathSecret;
  const state = attempt.state as MathState;
  return secret.ladder[state.index]![state.rungs[state.index] ?? spec.baseRung]!.answer;
}

describe('the referee asks the Director for a round', () => {
  beforeEach(() => freshWorld());
  afterEach(() => {
    referee.stop();
    director.reset();
    teardownWorld();
  });

  it('records a directive in the transcript when a round is actually played', () => {
    // The gap this closes, stated as a test: before this, the transcript of a
    // fully-played hunt was empty.
    const hunt = huntOfType('math');
    const { attempt } = attemptFor(hunt, '0xaa');

    expect(director.transcriptOf(hunt.id)?.list()).toHaveLength(0);

    referee.submitInputs(attempt.id, [{ seq: 1, kind: 'answer', t: 600 }].map(e => ({
      ...e,
      value: answerFor(hunt, attempt),
    })) as never, attempt.startedAt + 600);

    const entries = director.transcriptOf(hunt.id)?.list() ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.round).toBe(1);
  });

  it('hands every racer in a round the identical directive', () => {
    // Constraint 2. Two racers reaching round 1 a moment apart must get the same
    // game, or it is not a race — and `directiveFor` is write-once per round
    // precisely so that the second caller cannot be served something new.
    const hunt = huntOfType('math');
    const a = attemptFor(hunt, '0xaa');
    const b = attemptFor(hunt, '0xbb');

    for (const { attempt } of [a, b]) {
      referee.submitInputs(
        attempt.id,
        [{ seq: 1, kind: 'answer', t: 600, value: answerFor(hunt, attempt) }] as never,
        attempt.startedAt + 600,
      );
    }

    const rungOf = (attempt: Attempt) => (attempt.state as MathState).rungs[1];
    expect(rungOf(a.attempt)).toBe(rungOf(b.attempt));
    expect((a.attempt.state as MathState).window).toEqual(
      (b.attempt.state as MathState).window,
    );
    // One round issued, not one per racer.
    expect(director.transcriptOf(hunt.id)?.list()).toHaveLength(1);
  });

  it('never lets an identity reach the Director', () => {
    // The blind state is built inside the referee, which is the last place an
    // attempt object exists. If a handle or an attempt id could get through,
    // this is where it would happen.
    const seen: unknown[] = [];
    const real = director.stateFrom;
    const spy = vi.spyOn(director, 'stateFrom');
    // Capture what the real builder produced, not a reconstruction of it — the
    // object handed to `directiveFor` is the thing under test here.
    spy.mockImplementation((round, progress, elapsedMs) => {
      const state = real(round, progress, elapsedMs);
      seen.push(state);
      return state;
    });

    const hunt = huntOfType('math');
    const { attempt } = attemptFor(hunt, '0xaa');
    referee.submitInputs(
      attempt.id,
      [{ seq: 1, kind: 'answer', t: 600, value: answerFor(hunt, attempt) }] as never,
      attempt.startedAt + 600,
    );

    expect(seen.length).toBeGreaterThan(0);
    for (const state of seen) {
      // Numbers only. There is no field to put a player in, and this asserts
      // nobody handed one through anyway.
      expect(stateSchema.safeParse(state).success).toBe(true);
      expect(JSON.stringify(state)).not.toContain('at_');
      expect(JSON.stringify(state)).not.toContain('0xaa');
    }
    spy.mockRestore();
  });

  it('never asks for a directive on behalf of an undirected module', () => {
    // Tap and Sequence declare no `directedRound`, so the Director cannot affect
    // them even by accident — the referee never calls it at all.
    const hunt = huntOfType('tap');
    const { attempt } = attemptFor(hunt, '0xcc');

    referee.submitInputs(
      attempt.id,
      [{ seq: 1, kind: 'tap', t: 300 }] as never,
      attempt.startedAt + 300,
    );

    expect(director.transcriptOf(hunt.id)?.list()).toHaveLength(0);
  });

  it('keeps playing a hunt whose session did not survive a restart', () => {
    // Sessions are in memory and hunts outlive the process that made them. A
    // surviving hunt that fell back on an empty salt would quietly be a
    // different game from the one it started as.
    const hunt = huntOfType('math');
    director.reset(); // the restart

    const { attempt } = attemptFor(hunt, '0xdd');
    referee.submitInputs(
      attempt.id,
      [{ seq: 1, kind: 'answer', t: 600, value: answerFor(hunt, attempt) }] as never,
      attempt.startedAt + 600,
    );

    const transcript = director.transcriptOf(hunt.id);
    expect(transcript, 'the chain was never reopened').not.toBeNull();
    expect(transcript!.list()).toHaveLength(1);
  });

  it('is unaffected by the model being unavailable', () => {
    // The property that makes it safe to put a model here at all: with no
    // inference configured — which is the state these tests run in — every hunt
    // plays exactly as it did before phase 8, on the deterministic fallback.
    const hunt = huntOfType('math');
    const { attempt } = attemptFor(hunt, '0xee');

    // The block's own count, not a hardcoded three: how many questions a math
    // round asks is a property of the block now, so a fixed loop would answer
    // three of a five-question hunt and call the shortfall a Director failure.
    const rounds = (store.blockGame(hunt).spec as MathSpec).count;
    let t = 600;
    for (let i = 0; i < rounds; i++) {
      referee.submitInputs(
        attempt.id,
        [{ seq: i + 1, kind: 'answer', t, value: answerFor(hunt, attempt) }] as never,
        attempt.startedAt + t,
      );
      t += 600;
    }

    expect(attempt.status).not.toBe('failed');
    expect(mathModule.progress(attempt.state as MathState, store.blockGame(hunt).spec as MathSpec)).toBe(
      100,
    );
  });

  it('records one directive per round actually played, and no more', () => {
    // Found by playing a hunt rather than by a test: the last input has no next
    // round to shape, and asking anyway wrote a directive for a round that does
    // not exist into the transcript. A record of decisions nobody took is worse
    // than useless in a document whose whole purpose is to be checked.
    const hunt = huntOfType('math');
    const { attempt } = attemptFor(hunt, '0xff');
    const count = (store.blockGame(hunt).spec as MathSpec).count;

    let t = 600;
    for (let i = 0; i < count; i++) {
      referee.submitInputs(
        attempt.id,
        [{ seq: i + 1, kind: 'answer', t, value: answerFor(hunt, attempt) }] as never,
        attempt.startedAt + t,
      );
      t += 600;
    }

    const rounds = director.transcriptOf(hunt.id)!.list().map(e => e.round);
    // Round 0 is undirected, and there is nothing after the last one.
    expect(rounds).toEqual([...Array(count - 1)].map((_, i) => i + 1));
  });
});
