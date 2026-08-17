import { describe, expect, it } from 'vitest';
import { MEMORY } from '../config';
import { gameTypeForBlock } from './index';
import { memoryModule, type MemSpec, type MemState } from './memory';
import type { Timing } from './types';

function step(spec: MemSpec, state: MemState, sinceStart: number, sinceLast: number | null, value: unknown, kind = 'pad') {
  const timing: Timing = { sinceStart, sinceLast, intervals: [] };
  return memoryModule.step({ spec, secret: null, state, timing, directive: null }, { kind, value });
}

/** Plays the whole sequence correctly, starting after playback ends. */
function playAll(spec: MemSpec) {
  const state = memoryModule.init(spec);
  let t = spec.playbackMs;
  let result;
  for (let i = 0; i < spec.sequence.length; i++) {
    t += MEMORY.minIntervalMs + 100;
    result = step(spec, state, t, i === 0 ? null : MEMORY.minIntervalMs + 100, spec.sequence[i]);
  }
  return { result, state };
}

describe('memory module', () => {
  const { spec } = memoryModule.generate('block-salt', 'med');

  it('is deterministic for a given block', () => {
    expect(memoryModule.generate('block-salt', 'med').spec.sequence).toEqual(spec.sequence);
  });

  it('stays within the pad range', () => {
    for (const pad of spec.sequence) {
      expect(pad).toBeGreaterThanOrEqual(0);
      expect(pad).toBeLessThan(MEMORY.padCount);
    }
  });

  it('derives limitMs from playback plus an input budget', () => {
    expect(spec.limitMs).toBe(spec.playbackMs + MEMORY.inputBudgetMs);
  });

  it('scales length with difficulty', () => {
    expect(memoryModule.generate('s', 'easy').spec.sequence.length).toBeLessThan(
      spec.sequence.length,
    );
    expect(memoryModule.generate('s', 'hard').spec.sequence.length).toBeGreaterThan(
      spec.sequence.length,
    );
  });

  it('completes on a correct replay', () => {
    const { result, state } = playAll(spec);
    expect(result!.kind).toBe('complete');
    expect(memoryModule.progress(state, spec)).toBe(100);
  });

  it('rejects input before playback has finished', () => {
    const state = memoryModule.init(spec);
    // Pressing early is not fast reflexes — it is a client reading the spec
    // instead of watching the animation.
    expect(step(spec, state, spec.playbackMs - 50, null, spec.sequence[0])).toMatchObject({
      kind: 'reject',
      reason: 'input_before_playback_end',
      fatal: true,
    });
  });

  it('fails on a wrong pad', () => {
    const state = memoryModule.init(spec);
    const wrong = (spec.sequence[0]! + 1) % MEMORY.padCount;
    expect(step(spec, state, spec.playbackMs + 200, null, wrong)).toMatchObject({
      kind: 'reject',
      reason: 'wrong_order',
      fatal: true,
    });
  });

  it('rejects a pad outside the range', () => {
    const state = memoryModule.init(spec);
    expect(step(spec, state, spec.playbackMs + 200, null, 99)).toMatchObject({
      kind: 'reject',
      reason: 'pad_out_of_range',
    });
    expect(step(spec, state, spec.playbackMs + 200, null, -1)).toMatchObject({
      kind: 'reject',
      reason: 'pad_out_of_range',
    });
  });

  it('enforces the recall interval floor', () => {
    const state = memoryModule.init(spec);
    step(spec, state, spec.playbackMs + 200, null, spec.sequence[0]);
    expect(
      step(spec, state, spec.playbackMs + 250, MEMORY.minIntervalMs - 1, spec.sequence[1]),
    ).toMatchObject({ kind: 'reject', reason: 'interval_floor' });
  });
});

describe('game assignment', () => {
  it('never puts memory on a cash block', () => {
    // Memory hands the answer to the client by necessity, so it must only ever
    // guard XP. This is the invariant that keeps that true.
    for (let i = 0; i < 500; i++) {
      expect(gameTypeForBlock(`salt-${i}`, `hunt-${i}`, 'cash')).not.toBe('memory');
    }
  });

  it('draws puzzle blocks from the whole reflex pool', () => {
    // Puzzle hunts were hardcoded to `memory`, so three of the four reflex
    // modules had never once been served since the cash pool stopped drawing
    // them. Puzzle hunts are now the overwhelming majority of the map, so this
    // is where that variety has to live.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(gameTypeForBlock(`salt-${i}`, `hunt-${i}`, 'puzzle'));
    expect(seen).toEqual(new Set(['tap', 'math', 'sequence', 'memory']));
  });

  it('never puts a reflex game on a cash block', () => {
    // Losing a prize because your phone stuttered is the thing phase 4 removes.
    for (let i = 0; i < 200; i++) {
      expect(gameTypeForBlock(`salt-${i}`, `hunt-${i}`, 'cash')).toBe('crack');
    }
  });

  it('is stable for the same block', () => {
    expect(gameTypeForBlock('s', 'h', 'cash')).toBe(gameTypeForBlock('s', 'h', 'cash'));
  });

  it('serves exactly one cash game, whatever the salt', () => {
    // Every deep competitive game has one way to win and puts its variety
    // upstream of that. The variety here is the map, the hints and the market.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(gameTypeForBlock(`s${i}`, `h${i}`, 'cash'));
    expect(seen).toEqual(new Set(['crack']));
  });
});
