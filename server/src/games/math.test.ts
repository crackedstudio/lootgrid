import { describe, expect, it } from 'vitest';
import { MATH } from '../config';
import { mathModule, type MathSecret, type MathSpec, type MathState } from './math';
import type { Timing } from './types';

function step(
  spec: MathSpec,
  secret: MathSecret,
  state: MathState,
  sinceStart: number,
  value: unknown,
  kind = 'answer',
) {
  const timing: Timing = { sinceStart, sinceLast: null, intervals: [] };
  return mathModule.step({ spec, secret, state, timing }, { kind, value });
}

describe('math module', () => {
  const { spec, secret } = mathModule.generate('block-salt', 'med');

  it('is deterministic for a given block', () => {
    const again = mathModule.generate('block-salt', 'med');
    expect(again.secret.questions).toEqual(secret.questions);
  });

  it('differs between blocks', () => {
    const other = mathModule.generate('other-salt', 'med');
    expect(other.secret.questions).not.toEqual(secret.questions);
  });

  it('generates the configured number of questions', () => {
    expect(secret.questions).toHaveLength(MATH.count);
  });

  it('always includes the answer among four distinct options', () => {
    for (const q of secret.questions) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.options).toContain(q.answer);
    }
  });

  it('never produces a negative answer', () => {
    for (let i = 0; i < 200; i++) {
      const g = mathModule.generate(`salt-${i}`, 'hard');
      for (const q of g.secret.questions) expect(q.answer).toBeGreaterThanOrEqual(0);
    }
  });

  // --- the reason math is the most bot-resistant of the four ---

  it('sends only the first question, and never its answer', () => {
    const pub = mathModule.publicSpec(spec, secret) as Record<string, unknown>;
    expect(pub.index).toBe(0);
    expect(JSON.stringify(pub)).not.toContain('"answer"');
    expect((pub.question as { q: string }).q).toBe(secret.questions[0]!.q);
    // Questions 2 and 3 must not be reachable from what the client receives.
    expect(JSON.stringify(pub)).not.toContain(secret.questions[1]!.q);
  });

  it('issues the next question only after a correct answer', () => {
    const state = mathModule.init(spec);
    const result = step(spec, secret, state, 500, secret.questions[0]!.answer);
    expect(result.kind).toBe('progress');
    if (result.kind === 'progress') {
      const emit = result.emit as { index: number; question: { q: string } };
      expect(emit.index).toBe(1);
      expect(emit.question.q).toBe(secret.questions[1]!.q);
      expect(JSON.stringify(emit)).not.toContain('"answer"');
    }
  });

  it('completes after the full streak', () => {
    const state = mathModule.init(spec);
    let t = 0;
    let result;
    for (let i = 0; i < MATH.count; i++) {
      t += 600;
      result = step(spec, secret, state, t, secret.questions[i]!.answer);
    }
    expect(result!.kind).toBe('complete');
    expect(mathModule.progress(state, spec)).toBe(100);
  });

  it('fails on a wrong answer', () => {
    const state = mathModule.init(spec);
    const wrong = secret.questions[0]!.options.find(o => o !== secret.questions[0]!.answer)!;
    expect(step(spec, secret, state, 500, wrong)).toMatchObject({
      kind: 'reject',
      reason: 'wrong_answer',
      fatal: true,
    });
  });

  it('rejects a superhuman answer time', () => {
    const state = mathModule.init(spec);
    expect(step(spec, secret, state, MATH.minAnswerMs - 1, secret.questions[0]!.answer)).toMatchObject(
      { kind: 'reject', reason: 'answered_too_fast' },
    );
  });

  it('measures answer time per question, not from the start', () => {
    const state = mathModule.init(spec);
    step(spec, secret, state, 5_000, secret.questions[0]!.answer);
    // 200ms after the previous answer is too fast even though 5.2s have elapsed.
    expect(step(spec, secret, state, 5_200, secret.questions[1]!.answer)).toMatchObject({
      kind: 'reject',
      reason: 'answered_too_fast',
    });
  });

  it('rejects a stalled answer', () => {
    const state = mathModule.init(spec);
    expect(
      step(spec, secret, state, MATH.maxAnswerMs + 100, secret.questions[0]!.answer),
    ).toMatchObject({ kind: 'reject', reason: 'answered_too_slow' });
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
