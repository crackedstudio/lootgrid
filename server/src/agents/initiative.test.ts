import { describe, expect, it } from 'vitest';
import type { Condition } from '../director/world';
import { freshWorld, teardownWorld } from '../testing/harness';
import { afterEach, beforeEach } from 'vitest';
import * as budget from './budget';
import { APPETITE, choose, score, type Candidate } from './initiative';
import { personaFor } from './persona';

/**
 * Choosing when to act, and which hunt to take.
 *
 * The behaviour under test is disagreement. A zone full of agents that all take
 * the first listed hunt at the same instant is the most mechanical thing a
 * player can see, and no amount of varied timing hides it — so the tests that
 * matter here are the ones showing two agents looking at one board and wanting
 * different things.
 *
 * The other half is a safety property, and it is the one that must not bend: an
 * appetite is a preference between things already permitted. It can never make
 * something permitted that was not.
 */

const FLASH = 'deepseek-v4-flash';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const many = Array.from({ length: 300 }, (_, i) => personaFor(addr(i + 1)));

const hunt = (over: Partial<Candidate> = {}): Candidate => ({
  huntId: 'h1',
  difficulty: 'med',
  entrants: 1,
  ...over,
});

beforeEach(() => freshWorld());
afterEach(() => teardownWorld());

describe('appetite never authorises anything', () => {
  /**
   * Enough entrants that the easy tier is genuinely negative-EV.
   *
   * Derived rather than hardcoded, for the reason `budget.test` gives about its
   * own numbers: prices and the prize band have both moved by an order of
   * magnitude before, and a literal here would quietly stop testing anything the
   * day the cheap tier got cheaper.
   */
  const unviableEntrants = (() => {
    for (let n = 2; n < 100_000; n++) if (!budget.viableFor('easy', n, FLASH)) return n;
    throw new Error('easy is viable at any contention — re-derive this test');
  })();

  it('scores an unviable hunt at zero, for every persona and every weather', () => {
    // The floor. `viableFor` already refuses a negative-EV hunt, and no
    // temperament — and no weather — may overrule that arithmetic.
    const crowded = hunt({ difficulty: 'easy', entrants: unviableEntrants });

    const weathers: Array<Condition | null> = [
      null,
      { kind: 'goldrush', intensity: 3 },
      { kind: 'calm', intensity: 1 },
    ];
    for (const persona of many) {
      for (const weather of weathers) {
        expect(score(crowded, persona, weather, FLASH)).toBe(0);
      }
    }
  });

  it('never returns a choice that was not viable', () => {
    const unviable = [hunt({ huntId: 'a', difficulty: 'easy', entrants: unviableEntrants })];
    for (const persona of many.slice(0, 50)) {
      expect(
        choose(unviable, persona, { kind: 'goldrush', intensity: 3 }, FLASH, addr(1)),
      ).toBeNull();
    }
  });

  it('keeps every score inside 0..1', () => {
    const boards = [
      hunt(),
      hunt({ difficulty: 'hard', entrants: 1 }),
      hunt({ difficulty: 'easy', entrants: 2 }),
      hunt({ difficulty: 'hard', entrants: 8 }),
    ];
    for (const persona of many) {
      for (const c of boards) {
        for (const w of [null, { kind: 'goldrush', intensity: 3 } as Condition]) {
          const s = score(c, persona, w, FLASH);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('agents disagree about the same board', () => {
  const board: Candidate[] = [
    { huntId: 'quiet-hard', difficulty: 'hard', entrants: 1 },
    { huntId: 'busy-med', difficulty: 'med', entrants: 4 },
    { huntId: 'quiet-med', difficulty: 'med', entrants: 1 },
  ];

  it('does not send every agent to the same hunt', () => {
    // THE test. If this collapses to one hunt, the tell is back and everything
    // else in this module is decoration.
    const picks = new Set(
      many
        .map((p, i) => choose(board, p, null, FLASH, addr(i + 1))?.candidate.huntId)
        .filter(Boolean),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it('does not just take whatever is listed first', () => {
    // Reversing the board must not reverse the answers. If it does, the choice
    // is list order wearing a score.
    for (const [i, persona] of many.slice(0, 100).entries()) {
      const forward = choose(board, persona, null, FLASH, addr(i + 1));
      const backward = choose([...board].reverse(), persona, null, FLASH, addr(i + 1));
      expect(backward?.candidate.huntId).toBe(forward?.candidate.huntId);
    }
  });

  it('sends nervy agents to the hard hunt more than steady ones', () => {
    const base = personaFor(addr(5));
    const nervy = choose(board, { ...base, nerve: 100 }, null, FLASH, addr(5));
    const steady = choose(board, { ...base, nerve: 0 }, null, FLASH, addr(5));
    expect(nervy?.candidate.difficulty).toBe('hard');
    expect(steady?.candidate.difficulty).not.toBe('hard');
  });

  it('lets bold agents tolerate a crowd that timid ones avoid', () => {
    const base = personaFor(addr(9));
    const crowded = hunt({ entrants: 5 });
    const bold = score(crowded, { ...base, boldness: 100 }, null, FLASH);
    const timid = score(crowded, { ...base, boldness: 0 }, null, FLASH);
    expect(bold).toBeGreaterThan(timid);
  });
});

describe('waiting is a real answer', () => {
  it('returns null when nothing clears the bar', () => {
    // An agent holding out is behaving, not broken. `driver` reads this as
    // "no entry this tick" rather than as an error.
    const dull = [hunt({ difficulty: 'easy', entrants: 3 })];
    const picky = { ...personaFor(addr(3)), boldness: 0, nerve: 100 };
    const result = choose(dull, picky, { kind: 'fogbank', intensity: 3 }, FLASH, addr(3));
    if (result) expect(result.score).toBeGreaterThanOrEqual(APPETITE);
  });

  it('does not starve every agent on a reasonable board', () => {
    // The failure mode opposite to the tell: a bar so high the zone looks
    // abandoned. Most agents should find a quiet medium hunt acceptable.
    const board = [{ huntId: 'quiet-med', difficulty: 'med' as const, entrants: 1 }];
    const entering = many.filter((p, i) => choose(board, p, null, FLASH, addr(i + 1)) !== null);
    expect(entering.length).toBeGreaterThan(many.length * 0.5);
  });
});

describe('weather reaches the decision without costing a call', () => {
  it('makes agents keener in a goldrush than in a fogbank', () => {
    const c = hunt();
    const keener = many.map(p => score(c, p, { kind: 'goldrush', intensity: 3 }, FLASH));
    const duller = many.map(p => score(c, p, { kind: 'fogbank', intensity: 3 }, FLASH));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(keener)).toBeGreaterThan(mean(duller));
  });

  it('treats no weather as a neutral middle rather than a refusal', () => {
    // A zone with no condition yet must still be playable — otherwise the first
    // ninety seconds after a restart is a dead zone.
    const c = hunt();
    for (const p of many.slice(0, 50)) {
      expect(score(c, p, null, FLASH)).toBeGreaterThan(0);
    }
  });
});
