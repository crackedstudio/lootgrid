import { describe, expect, it } from 'vitest';
import { MATH } from '../config';
import type { Directive } from '../director/types';
import { mathModule, windowFor, type MathSecret, type MathSpec, type MathState } from './math';
import type { Timing } from './types';

function step(
  spec: MathSpec,
  secret: MathSecret,
  state: MathState,
  sinceStart: number,
  value: unknown,
  kind = 'answer',
  directive: Directive | null = null,
) {
  const timing: Timing = { sinceStart, sinceLast: null, intervals: [] };
  return mathModule.step({ spec, secret, state, timing, directive }, { kind, value });
}

/** The question the player is actually looking at, at the rung it was served. */
const served = (secret: MathSecret, spec: MathSpec, state: MathState) =>
  secret.ladder[state.index]![state.rungs[state.index] ?? spec.baseRung]!;

const directive = (over: Partial<Directive> = {}): Directive => ({
  difficulty: 3,
  roundType: 'standard',
  twist: 'none',
  ...over,
});

describe('math module', () => {
  const { spec, secret } = mathModule.generate('block-salt', 'med');
  /** Every question at the block's own rung — what an undirected hunt serves. */
  const base = secret.ladder.map(rungs => rungs[spec.baseRung]!);

  it('is deterministic for a given block', () => {
    const again = mathModule.generate('block-salt', 'med');
    expect(again.secret.ladder).toEqual(secret.ladder);
  });

  it('differs between blocks', () => {
    const other = mathModule.generate('other-salt', 'med');
    expect(other.secret.ladder).not.toEqual(secret.ladder);
  });

  it('generates the configured number of questions', () => {
    expect(secret.ladder).toHaveLength(MATH.count);
  });

  it('always includes the answer among four distinct options, at every rung', () => {
    for (const rungs of secret.ladder) {
      for (const q of rungs) {
        expect(q.options).toHaveLength(4);
        expect(new Set(q.options).size).toBe(4);
        expect(q.options).toContain(q.answer);
      }
    }
  });

  it('never produces a negative answer', () => {
    for (let i = 0; i < 200; i++) {
      const g = mathModule.generate(`salt-${i}`, 'hard');
      for (const rungs of g.secret.ladder) {
        for (const q of rungs) expect(q.answer).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // --- the reason math is the most bot-resistant of the four ---

  it('sends only the first question, and never its answer', () => {
    const pub = mathModule.publicSpec(spec, secret) as Record<string, unknown>;
    expect(pub.index).toBe(0);
    expect(JSON.stringify(pub)).not.toContain('"answer"');
    expect((pub.question as { q: string }).q).toBe(base[0]!.q);
    // Questions 2 and 3 must not be reachable from what the client receives.
    expect(JSON.stringify(pub)).not.toContain(base[1]!.q);
  });

  it('never leaks a rung the player was not served', () => {
    // The ladder is five times as much secret as before. All of it stays here.
    const pub = JSON.stringify(mathModule.publicSpec(spec, secret));
    for (const rungs of secret.ladder) {
      for (const [rung, q] of rungs.entries()) {
        if (rung === spec.baseRung && q === secret.ladder[0]![spec.baseRung]) continue;
        if (q.q === base[0]!.q) continue;
        expect(pub).not.toContain(`"${q.q}"`);
      }
    }
  });

  it('issues the next question only after a correct answer', () => {
    const state = mathModule.init(spec);
    const result = step(spec, secret, state, 500, base[0]!.answer);
    expect(result.kind).toBe('progress');
    if (result.kind === 'progress') {
      const emit = result.emit as { index: number; question: { q: string } };
      expect(emit.index).toBe(1);
      expect(emit.question.q).toBe(base[1]!.q);
      expect(JSON.stringify(emit)).not.toContain('"answer"');
    }
  });

  it('completes after the full streak', () => {
    const state = mathModule.init(spec);
    let t = 0;
    let result;
    for (let i = 0; i < MATH.count; i++) {
      t += 600;
      result = step(spec, secret, state, t, served(secret, spec, state).answer);
    }
    expect(result!.kind).toBe('complete');
    expect(mathModule.progress(state, spec)).toBe(100);
  });

  it('fails on a wrong answer', () => {
    const state = mathModule.init(spec);
    const wrong = base[0]!.options.find(o => o !== base[0]!.answer)!;
    expect(step(spec, secret, state, 500, wrong)).toMatchObject({
      kind: 'reject',
      reason: 'wrong_answer',
      fatal: true,
    });
  });

  it('rejects a superhuman answer time', () => {
    const state = mathModule.init(spec);
    expect(step(spec, secret, state, MATH.minAnswerMs - 1, base[0]!.answer)).toMatchObject({
      kind: 'reject',
      reason: 'answered_too_fast',
    });
  });

  it('measures answer time per question, not from the start', () => {
    const state = mathModule.init(spec);
    step(spec, secret, state, 5_000, base[0]!.answer);
    // 200ms after the previous answer is too fast even though 5.2s have elapsed.
    expect(step(spec, secret, state, 5_200, base[1]!.answer)).toMatchObject({
      kind: 'reject',
      reason: 'answered_too_fast',
    });
  });

  it('rejects a stalled answer', () => {
    const state = mathModule.init(spec);
    expect(step(spec, secret, state, MATH.maxAnswerMs + 100, base[0]!.answer)).toMatchObject({
      kind: 'reject',
      reason: 'answered_too_slow',
    });
  });

  it('rejects non-numeric and wrong-kind input', () => {
    const state = mathModule.init(spec);
    expect(step(spec, secret, state, 500, 'seven')).toMatchObject({ kind: 'reject' });
    expect(step(spec, secret, state, 500, 1, 'tap')).toMatchObject({
      kind: 'reject',
      reason: 'bad_input',
    });
  });
});

/**
 * The Director shaping a round.
 *
 * Phase 8 built a Director that recorded decisions nothing acted on. These are
 * the tests for it actually reaching a game — and for the two things that must
 * survive it doing so: a hunt still replays from its salt, and a player is still
 * judged against what they were shown.
 */
describe('a directed round', () => {
  const { spec, secret } = mathModule.generate('directed-salt', 'med');
  const base = secret.ladder.map(rungs => rungs[spec.baseRung]!);

  it('plays exactly as before when nothing directs it', () => {
    // The property the whole design rests on: a Director that never answers
    // leaves the game identical to phase 3. Null is not an error path.
    const state = mathModule.init(spec);
    const result = step(spec, secret, state, 600, base[0]!.answer, 'answer', null);

    expect(result.kind).toBe('progress');
    expect(state.rungs[1]).toBe(spec.baseRung);
    expect(state.window).toEqual({ minMs: MATH.minAnswerMs, maxMs: MATH.maxAnswerMs });
  });

  it('serves the next round at the rung the Director asked for', () => {
    const state = mathModule.init(spec);
    const result = step(spec, secret, state, 600, base[0]!.answer, 'answer', directive({ difficulty: 5 }));

    expect(state.rungs[1]).toBe(4);
    if (result.kind === 'progress') {
      const emit = result.emit as { question: { q: string } };
      expect(emit.question.q).toBe(secret.ladder[1]![4]!.q);
    }
  });

  it('leaves round 0 alone whatever the Director says', () => {
    // It goes out in publicSpec before anyone has made progress. A model that
    // could set the opening question would be shaping a round it cannot have
    // read anything into.
    expect(mathModule.init(spec).rungs[0]).toBe(spec.baseRung);
  });

  it('judges an answer against the round that was served, not the current one', () => {
    // THE test for the whole seam. The directive moves between the question
    // going out and the answer coming back — which it will, because a directive
    // is fetched per input. The player must be graded on what they saw.
    const state = mathModule.init(spec);
    step(spec, secret, state, 600, base[0]!.answer, 'answer', directive({ difficulty: 1 }));

    const shown = secret.ladder[1]![0]!;
    expect(state.rungs[1]).toBe(0);

    // A completely different directive arrives with the answer to that question.
    const result = step(spec, secret, state, 1_400, shown.answer, 'answer', directive({ difficulty: 5 }));
    expect(result.kind).not.toBe('reject');
  });

  it('publishes the clock it is asking the player to race', () => {
    const state = mathModule.init(spec);
    const result = step(
      spec,
      secret,
      state,
      600,
      base[0]!.answer,
      'answer',
      directive({ roundType: 'sprint', twist: 'haste' }),
    );

    if (result.kind === 'progress') {
      const emit = result.emit as { minAnswerMs: number; maxAnswerMs: number };
      // A round that quietly shortened somebody's clock would be the Director
      // taking a prize away — the thing blinding it is supposed to prevent.
      expect(emit.maxAnswerMs).toBe(state.window.maxMs);
      expect(emit.maxAnswerMs).toBeLessThan(MATH.maxAnswerMs);
    }
  });

  it('enforces the published window rather than the default one', () => {
    const state = mathModule.init(spec);
    step(spec, secret, state, 600, base[0]!.answer, 'answer', directive({ twist: 'haste' }));

    const shown = secret.ladder[1]![2]!;
    const tooSlow = 600 + state.window.maxMs + 50;
    expect(step(spec, secret, state, tooSlow, shown.answer)).toMatchObject({
      reason: 'answered_too_slow',
    });
  });

  it('cannot compress a round below what a human needs to read it', () => {
    // The floor no combination of knobs may push through.
    for (const roundType of ['standard', 'sprint', 'endurance', 'precision'] as const) {
      for (const twist of ['none', 'fog', 'decoys', 'silence', 'haste'] as const) {
        const w = windowFor(directive({ roundType, twist }));
        expect(w.maxMs - w.minMs, `${roundType}/${twist}`).toBeGreaterThanOrEqual(
          MATH.minAnswerMs * 4,
        );
      }
    }
  });

  it('keeps the hunt replayable from its salt', () => {
    // The Director SELECTS a rung, it never generates one. So the full space of
    // questions a hunt can serve is fixed before anyone enters, and salt plus
    // transcript still reconstructs the exact game that was played.
    const a = mathModule.generate('replay-salt', 'hard');
    const b = mathModule.generate('replay-salt', 'hard');
    expect(a.secret).toEqual(b.secret);

    for (let rung = 0; rung < 5; rung++) {
      expect(a.secret.ladder[1]![rung]).toEqual(b.secret.ladder[1]![rung]);
    }
  });

  it('keeps the pre-Director ranges on the rungs the block difficulties use', () => {
    // Rungs 1/2/3 are the old easy/med/hard. The Director added a rung either
    // side rather than moving the ground under the three that were measured.
    expect(mathModule.generate('s', 'easy').spec.baseRung).toBe(1);
    expect(mathModule.generate('s', 'med').spec.baseRung).toBe(2);
    expect(mathModule.generate('s', 'hard').spec.baseRung).toBe(3);
  });

  it('still plays a block generated before the ladder existed', () => {
    // Persisted block games outlive a deploy. A race that failed mid-way because
    // the server was redeployed under it would be the worse bug.
    const legacy = { questions: base } as MathSecret;
    const state = mathModule.init(spec);
    expect(step(spec, legacy, state, 600, base[0]!.answer)).toMatchObject({ kind: 'progress' });
  });
});
