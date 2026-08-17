import { describe, expect, it } from 'vitest';
import { CRACK, GRID } from '../config';
import { crackModule, doorsFor, isCorrect, type CrackSpec, type CrackState } from './crack';

/**
 * The Crack.
 *
 * The property this file exists to defend is negative: nothing here may depend
 * on how fast anyone was. An instant lock and a lock at 14.9 seconds must be
 * indistinguishable, because "I lost because my phone is slow" is the belief
 * this game was built to make impossible.
 */

const cell = { r: 17, c: 41 };

const gen = (seed = 'salt-a', at = cell) => crackModule.generate(seed, 'med', { cell: at });

describe('the doors', () => {
  it('offers exactly the configured number', () => {
    const { spec } = gen();
    expect((spec as CrackSpec).candidates).toHaveLength(CRACK.doors);
  });

  it('always includes the real cell', () => {
    // The whole reason `generate` takes a cell. If the answer were derived from
    // the seed instead, hints would describe a position nobody is picking and
    // the entire deduction economy would be pricing unusable information.
    for (let i = 0; i < 100; i++) {
      const at = { r: (i * 7) % GRID.rows, c: (i * 13) % GRID.cols };
      const { spec, secret } = gen(`s${i}`, at);
      const candidates = (spec as CrackSpec).candidates;
      expect(candidates).toContainEqual(at);
      expect(candidates[(secret as { answer: number }).answer]).toEqual(at);
    }
  });

  it('never repeats a door', () => {
    for (let i = 0; i < 100; i++) {
      const { spec } = gen(`s${i}`);
      const keys = (spec as CrackSpec).candidates.map(c => `${c.r},${c.c}`);
      expect(new Set(keys).size).toBe(CRACK.doors);
    }
  });

  it('does not always hide the answer in the same slot', () => {
    // A fixed position would end the game before it started.
    const slots = new Set<number>();
    for (let i = 0; i < 200; i++) slots.add(doorsFor(`s${i}`, cell).answer);
    expect(slots.size).toBe(CRACK.doors);
  });

  /**
   * Checkable after the fact, like everything else about a block.
   *
   * The salt is committed at hunt creation and revealed at settlement, so
   * anyone can recompute the six doors and confirm the house did not add one,
   * move one, or show different doors to different players.
   */
  it('is a pure function of the salt and the cell', () => {
    const a = doorsFor('same-salt', cell);
    const b = doorsFor('same-salt', cell);
    expect(a).toEqual(b);
    expect(doorsFor('other-salt', cell)).not.toEqual(a);
  });

  it('scatters decoys across the map so hints can eliminate them', () => {
    // Decoys huddled around the answer would survive almost every hint and turn
    // this back into a coin flip with extra steps. Spread out, a quadrant hint
    // rules out roughly three quarters of them.
    const quadrants = new Set<string>();
    for (const c of (gen().spec as CrackSpec).candidates) {
      quadrants.add(`${c.r < GRID.rows / 2 ? 'N' : 'S'}${c.c < GRID.cols / 2 ? 'W' : 'E'}`);
    }
    expect(quadrants.size).toBeGreaterThan(1);
  });
});

describe('locking a door', () => {
  const play = () => {
    const { spec, secret } = gen();
    return { spec: spec as CrackSpec, secret, state: crackModule.init(spec as CrackSpec) };
  };

  const step = (g: ReturnType<typeof play>, value: unknown) =>
    crackModule.step(
      {
        spec: g.spec,
        secret: g.secret,
        state: g.state,
        timing: { sinceStart: 0, sinceLast: null, intervals: [] },
        directive: null,
      },
      { kind: 'lock', value },
    );

  it('completes the attempt whether the pick is right or wrong', () => {
    // Completing is not winning. Failing a wrong pick would leak the answer the
    // instant you locked, fifteen seconds before the reveal.
    const right = play();
    expect(step(right, right.spec.candidates[(right.secret as { answer: number }).answer])).toEqual({
      kind: 'complete',
    });

    const wrong = play();
    const bad = wrong.spec.candidates.find(
      (_, i) => i !== (wrong.secret as { answer: number }).answer,
    )!;
    expect(step(wrong, bad)).toEqual({ kind: 'complete' });
  });

  it('refuses a cell that is not one of the doors', () => {
    const g = play();
    expect(step(g, { r: 0, c: 0 })).toMatchObject({ kind: 'reject', fatal: true });
    expect(step(g, undefined)).toMatchObject({ kind: 'reject', fatal: true });
  });

  it('allows exactly one lock', () => {
    // A second would be a free re-roll on a prize.
    const g = play();
    step(g, g.spec.candidates[0]);
    expect(step(g, g.spec.candidates[1])).toMatchObject({
      kind: 'reject',
      reason: 'already_locked',
      fatal: true,
    });
  });

  /**
   * Nothing about the timing is judged, and this is the point of the phase.
   *
   * `tap` rejects intervals under 25ms and a standard deviation near zero,
   * because speed decides that game so a script that plays faster wins. Speed
   * decides nothing here — an instant lock and one at the buzzer score the same
   * — so a bot that picks a door has done exactly what a player does and beats
   * nobody by being quick.
   */
  it('judges an instant lock exactly as it judges a slow one', () => {
    const results = [0, 14_900].map(sinceStart => {
      const g = play();
      return crackModule.step(
        {
          spec: g.spec,
          secret: g.secret,
          state: g.state,
          timing: { sinceStart, sinceLast: null, intervals: [] },
          directive: null,
        },
        { kind: 'lock', value: g.spec.candidates[0] },
      );
    });
    expect(results[0]).toEqual(results[1]);
  });
});

describe('what the client is told', () => {
  it('sends the doors and never the answer', () => {
    const { spec, secret } = gen();
    const pub = JSON.stringify(crackModule.publicSpec(spec as CrackSpec, secret as never));
    expect(pub).toContain('candidates');
    expect(pub).not.toContain('answer');
    expect(pub).not.toContain(JSON.stringify(secret));
  });
});

describe('refusing to run without a cell', () => {
  it('throws rather than inventing an answer', () => {
    // A seed-derived answer would generate cleanly, play convincingly and be
    // unwinnable by anyone reasoning from hints — surfacing as "deduction feels
    // useless" rather than as an error anyone could find.
    expect(() => crackModule.generate('salt', 'med')).toThrow(/hunt cell/);
  });
});

describe('scoring a pick', () => {
  it('recognises the right door and only the right door', () => {
    const { spec, secret } = gen();
    const answer = (secret as { answer: number }).answer;
    expect(isCorrect({ picked: answer } as CrackState, secret)).toBe(true);
    for (let i = 0; i < CRACK.doors; i++) {
      if (i === answer) continue;
      expect(isCorrect({ picked: i } as CrackState, secret)).toBe(false);
    }
    expect(isCorrect({ picked: null } as CrackState, secret)).toBe(false);
  });
});
