import { describe, expect, it } from 'vitest';
import { SEQUENCE } from '../config';
import { sequenceModule, type SeqSpec, type SeqState } from './sequence';
import type { Timing } from './types';

function step(spec: SeqSpec, state: SeqState, sinceStart: number, sinceLast: number | null, value: unknown, kind = 'tap') {
  const timing: Timing = { sinceStart, sinceLast, intervals: [] };
  return sequenceModule.step({ spec, secret: null, state, timing }, { kind, value });
}

describe('sequence module', () => {
  const { spec } = sequenceModule.generate('block-salt', 'med');

  it('is deterministic for a given block', () => {
    expect(sequenceModule.generate('block-salt', 'med').spec.tiles).toEqual(spec.tiles);
  });

  it('shuffles differently between blocks', () => {
    const other = sequenceModule.generate('another-salt', 'med').spec;
    // Same set of ids, different arrangement.
    expect(other.tiles.map(t => t.id).sort()).toEqual(spec.tiles.map(t => t.id).sort());
  });

  it('contains every id exactly once', () => {
    const ids = spec.tiles.map(t => t.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: spec.n }, (_, i) => i + 1));
  });

  it('scales length with difficulty', () => {
    expect(sequenceModule.generate('s', 'easy').spec.n).toBeLessThan(spec.n);
    expect(sequenceModule.generate('s', 'hard').spec.n).toBeGreaterThan(spec.n);
  });

  it('completes when tapped in order', () => {
    const state = sequenceModule.init(spec);
    let result;
    for (let i = 1; i <= spec.n; i++) {
      result = step(spec, state, i * 200, i === 1 ? null : 200, i);
    }
    expect(result!.kind).toBe('complete');
    expect(sequenceModule.progress(state, spec)).toBe(100);
  });

  it('fails on the first out-of-order tap', () => {
    const state = sequenceModule.init(spec);
    step(spec, state, 200, null, 1);
    expect(step(spec, state, 400, 200, 3)).toMatchObject({
      kind: 'reject',
      reason: 'wrong_order',
      fatal: true,
    });
  });

  it('enforces the interval floor', () => {
    const state = sequenceModule.init(spec);
    step(spec, state, 200, null, 1);
    expect(step(spec, state, 210, SEQUENCE.minIntervalMs - 1, 2)).toMatchObject({
      kind: 'reject',
      reason: 'interval_floor',
      fatal: true,
    });
  });

  it('rejects a run past the limit', () => {
    const state = sequenceModule.init(spec);
    expect(step(spec, state, spec.limitMs + 1000, null, 1)).toMatchObject({
      kind: 'reject',
      reason: 'too_slow',
    });
  });

  it('rejects non-integer tile ids', () => {
    const state = sequenceModule.init(spec);
    expect(step(spec, state, 200, null, '1')).toMatchObject({ kind: 'reject', reason: 'bad_tile' });
  });

  it('reports partial progress', () => {
    const state = sequenceModule.init(spec);
    step(spec, state, 200, null, 1);
    expect(sequenceModule.progress(state, spec)).toBe(Math.round((1 / spec.n) * 100));
  });
});
