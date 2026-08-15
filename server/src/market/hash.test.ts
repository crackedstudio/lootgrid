import { describe, expect, it } from 'vitest';
import { GRID } from '../config';
import { canonicalPayload } from '../hints/commit';
import { candidateCells, type Hint, type HintPayload, type Quadrant } from '../hints/types';
import { hintHashMatches, hintHashOf, hintNonce } from './hash';

/**
 * The hash a hint is sold under.
 *
 * The failure this file exists to prevent is not subtle once seen and invisible
 * until then: a hash over a small, enumerable space is not a commitment, it is a
 * lookup table. The payload space here is about a thousand values, so an
 * unsalted hash would hand every buyer the hint for free before they paid.
 */

function makeHint(over: Partial<Hint> = {}): Hint {
  return {
    id: 'hunt-1:2',
    huntId: 'hunt-1',
    zoneId: 'ridge',
    epoch: 1,
    tier: 2,
    reliabilityBps: 7_000,
    payload: { kind: 'region', quadrant: 'NW' },
    expiresAt: null,
    ...over,
  };
}

const NONCE = hintNonce('salt-abc', 'hunt-1:2');

describe('the nonce', () => {
  it('is deterministic for a hunt and hint', () => {
    expect(hintNonce('salt-abc', 'hunt-1:2')).toBe(hintNonce('salt-abc', 'hunt-1:2'));
  });

  it('differs per hint within a hunt', () => {
    // Otherwise one delivered hint would unblind every other hint in the set.
    expect(hintNonce('salt-abc', 'hunt-1:2')).not.toBe(hintNonce('salt-abc', 'hunt-1:3'));
  });

  it('differs per hunt', () => {
    expect(hintNonce('salt-abc', 'hunt-1:2')).not.toBe(hintNonce('salt-xyz', 'hunt-1:2'));
  });
});

describe('the hash binds the whole public claim', () => {
  it('matches what a buyer recomputes from what they received', () => {
    const hint = makeHint();
    expect(hintHashMatches(hint, NONCE, hintHashOf(hint, NONCE))).toBe(true);
  });

  it.each([
    ['payload', { payload: { kind: 'region', quadrant: 'SE' } as HintPayload }],
    ['tier', { tier: 3 as const }],
    ['reliability', { reliabilityBps: 9_000 }],
    ['zone', { zoneId: 'delta' }],
    ['hunt', { huntId: 'hunt-2' }],
  ])('changes when the %s changes', (_what, over) => {
    // Each of these is something a seller could otherwise misrepresent: deliver
    // a different hint, or the same one relabelled as sharper than it is.
    expect(hintHashOf(makeHint(over), NONCE)).not.toBe(hintHashOf(makeHint(), NONCE));
  });

  it('is worthless without the nonce', () => {
    const hint = makeHint();
    const other = hintNonce('salt-abc', 'hunt-1:3');
    expect(hintHashOf(hint, other)).not.toBe(hintHashOf(hint, NONCE));
  });
});

describe('the hash does not leak the hint it is selling', () => {
  /**
   * The enumeration attack, run for real.
   *
   * Every payload a generator can produce, hashed against the hint's public
   * fields. If any of them reproduces the vouched hash without the nonce, a
   * buyer can read the hint before paying and the market is over.
   */
  it('cannot be brute-forced across the whole payload space', () => {
    const secret = makeHint({ payload: { kind: 'distance', r: 5, c: 3, within: 1 } });
    const vouched = hintHashOf(secret, NONCE);

    const quadrants: Quadrant[] = ['NW', 'NE', 'SW', 'SE'];
    const space: HintPayload[] = [
      ...quadrants.flatMap<HintPayload>(q => [
        { kind: 'region', quadrant: q },
        { kind: 'exclusion', quadrant: q },
      ]),
      { kind: 'parity', parity: 'even' },
      { kind: 'parity', parity: 'odd' },
    ];
    for (let from = 0; from < GRID.rows; from++) {
      for (let to = from; to < GRID.rows; to++) space.push({ kind: 'rowBand', from, to });
    }
    for (let from = 0; from < GRID.cols; from++) {
      for (let to = from; to < GRID.cols; to++) space.push({ kind: 'colBand', from, to });
    }
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        for (let within = 0; within <= 4; within++) space.push({ kind: 'distance', r, c, within });
      }
    }

    // Sanity: the space really does contain the answer, so a pass below means
    // the blinding worked rather than that the search was looking in the wrong
    // place.
    expect(space.map(canonicalPayload)).toContain(canonicalPayload(secret.payload));

    const guessedNonce = hintNonce('', secret.id);
    const cracked = space.filter(
      payload => hintHashOf({ ...secret, payload }, guessedNonce) === vouched,
    );
    expect(cracked).toEqual([]);
  });

  it('says nothing about whether the hint is true', () => {
    // `isTrue` is not on the public hint at all, so it cannot reach the hash —
    // and it must not, or a buyer holding payload and nonce could hash both
    // truth values and learn which one the house committed to.
    const hint = makeHint();
    expect(Object.keys(hint)).not.toContain('isTrue');
    // The hash is a pure function of the public claim: two hints identical to a
    // player are identical here, whatever the server knows about them.
    expect(hintHashOf({ ...hint }, NONCE)).toBe(hintHashOf(makeHint(), NONCE));
  });

  it('covers a payload that genuinely narrows the grid', () => {
    // Guards against the hash being computed over something inert. A payload
    // that rules nothing out would make the test above pass for free.
    expect(candidateCells(makeHint().payload).length).toBeLessThan(GRID.rows * GRID.cols);
  });
});
