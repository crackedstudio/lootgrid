import { describe, expect, it } from 'vitest';
import { GRID } from '../config';
import type { Hunt } from '../types';
import { HINT_DROP_PCT, hintDrop, hintsForHunt } from './generate';
import {
  HINTS_PER_HUNT,
  TIER_RELIABILITY_BPS,
  candidateCells,
  cellMatches,
  parsePayload,
  quadrantOf,
  sharpness,
  type HintTier,
} from './types';

/**
 * Hint generation.
 *
 * Two properties here are not merely nice: phase 2 cannot commit to a hint set
 * that is not reproducible, and its audit cannot check a deception rate that
 * does not match the advertised one. Both are asserted below.
 */

function makeHunt(over: Partial<Hunt> = {}): Hunt {
  return {
    id: 'hunt-1',
    zoneId: 'ridge',
    epoch: 1,
    r: 4,
    c: 3,
    salt: 'salt-abc',
    cellCommit: 'commit',
    kind: 'cash',
    difficulty: 'medium',
    prizeLabel: '$1.00',
    status: 'live',
    winnerId: null,
    game: null,
    expiresAt: 2_000_000,
    createdAt: 1_000_000,
    ...over,
  } as Hunt;
}

describe('determinism', () => {
  it('reproduces the identical set from the same salt', () => {
    const a = hintsForHunt(makeHunt());
    const b = hintsForHunt(makeHunt());
    // Phase 2 commits to keccak over these bytes before the hunt opens and
    // reveals them after. If this is ever unstable, the commitment is worthless.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces a different set for a different salt', () => {
    const a = hintsForHunt(makeHunt({ salt: 'salt-a' }));
    const b = hintsForHunt(makeHunt({ salt: 'salt-b' }));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('does not depend on player identity', () => {
    // The house must not be able to make YOUR hint the false one. Identity is
    // not an input to generation and must never become one — see phase 8.
    const hunt = makeHunt();
    const before = hintsForHunt(hunt);
    const after = hintsForHunt({ ...hunt });
    expect(after).toEqual(before);
  });

  it('emits the configured number of hints with stable ids', () => {
    const set = hintsForHunt(makeHunt());
    expect(set).toHaveLength(HINTS_PER_HUNT);
    expect(set.map(h => h.id)).toEqual(
      Array.from({ length: HINTS_PER_HUNT }, (_, i) => `hunt-1:${i}`),
    );
  });
});

describe('payloads are well formed', () => {
  it('always survives the untrusted-input parser', () => {
    // Everything crossing storage or the wire comes back through parsePayload.
    // A generator that emits something it rejects would drop hints silently.
    for (let i = 0; i < 300; i++) {
      for (const h of hintsForHunt(makeHunt({ id: `h${i}`, salt: `s${i}`, r: i % GRID.rows, c: i % GRID.cols }))) {
        expect(parsePayload(h.payload), JSON.stringify(h.payload)).not.toBeNull();
      }
    }
  });

  it('never describes a cell outside the grid', () => {
    for (let i = 0; i < 200; i++) {
      for (const h of hintsForHunt(makeHunt({ id: `h${i}`, salt: `s${i}` }))) {
        const cells = candidateCells(h.payload);
        expect(cells.length).toBeGreaterThan(0);
        for (const cell of cells) {
          expect(cell.r).toBeGreaterThanOrEqual(0);
          expect(cell.r).toBeLessThan(GRID.rows);
          expect(cell.c).toBeGreaterThanOrEqual(0);
          expect(cell.c).toBeLessThan(GRID.cols);
        }
      }
    }
  });

  it('advertises the reliability its tier promises', () => {
    for (let i = 0; i < 100; i++) {
      for (const h of hintsForHunt(makeHunt({ id: `h${i}`, salt: `s${i}` }))) {
        expect(h.reliabilityBps).toBe(TIER_RELIABILITY_BPS[h.tier]);
      }
    }
  });
});

describe('truth flags reflect what the hint actually says', () => {
  it('records isTrue by checking the payload against the real cell', () => {
    // Not "what we intended" — a decoy can land inside a wide band by accident,
    // and recording intent rather than reality would inflate observed accuracy
    // above the advertised rate and break phase 2's audit.
    for (let i = 0; i < 300; i++) {
      const hunt = makeHunt({ id: `h${i}`, salt: `s${i}`, r: i % GRID.rows, c: (i * 7) % GRID.cols });
      for (const h of hintsForHunt(hunt)) {
        expect(h.isTrue).toBe(cellMatches(h.payload, hunt.r, hunt.c));
      }
    }
  });

  it('lands near the advertised rate per tier over many hunts', () => {
    const seen: Record<number, { n: number; t: number }> = { 1: { n: 0, t: 0 }, 2: { n: 0, t: 0 }, 3: { n: 0, t: 0 } };
    for (let i = 0; i < 4_000; i++) {
      const hunt = makeHunt({ id: `h${i}`, salt: `s${i}`, r: i % GRID.rows, c: (i * 5) % GRID.cols });
      for (const h of hintsForHunt(hunt)) {
        seen[h.tier]!.n++;
        if (h.isTrue) seen[h.tier]!.t++;
      }
    }

    for (const tier of [1, 2, 3] as HintTier[]) {
      const observed = seen[tier]!.t / seen[tier]!.n;
      const advertised = TIER_RELIABILITY_BPS[tier] / 10_000;
      // Observed runs at or above advertised: a decoy sometimes coincides with
      // the truth, which can only help the player. Never materially below.
      expect(observed).toBeGreaterThanOrEqual(advertised - 0.03);
      expect(observed).toBeLessThanOrEqual(advertised + 0.25);
    }
  });
});

describe('precision is paid for in reliability', () => {
  it('makes sharper tiers less reliable', () => {
    expect(TIER_RELIABILITY_BPS[1]).toBeGreaterThan(TIER_RELIABILITY_BPS[2]);
    expect(TIER_RELIABILITY_BPS[2]).toBeGreaterThan(TIER_RELIABILITY_BPS[3]);
  });

  it('makes higher tiers eliminate more of the grid', () => {
    const avg: Record<number, number[]> = { 1: [], 2: [], 3: [] };
    for (let i = 0; i < 500; i++) {
      for (const h of hintsForHunt(makeHunt({ id: `h${i}`, salt: `s${i}` }))) {
        avg[h.tier]!.push(sharpness(h.payload));
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // The trade the whole market rests on: sharper information, worse odds.
    expect(mean(avg[3]!)).toBeGreaterThan(mean(avg[2]!));
    expect(mean(avg[2]!)).toBeGreaterThan(mean(avg[1]!));
  });
});

describe('geometry', () => {
  it('splits quadrants over the whole grid', () => {
    const seen = new Set<string>();
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) seen.add(quadrantOf(r, c));
    }
    expect([...seen].sort()).toEqual(['NE', 'NW', 'SE', 'SW']);
  });

  it('rejects malformed payloads rather than half-honouring them', () => {
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload({ kind: 'nope' })).toBeNull();
    expect(parsePayload({ kind: 'region', quadrant: 'XX' })).toBeNull();
    expect(parsePayload({ kind: 'rowBand', from: 5, to: 2 })).toBeNull();
    expect(parsePayload({ kind: 'rowBand', from: -1, to: 2 })).toBeNull();
    expect(parsePayload({ kind: 'distance', r: 0, c: 0, within: 99 })).toBeNull();
    // No free-text field exists, so an injection payload cannot ride along.
    expect(parsePayload({ kind: 'region', quadrant: 'NW', note: 'ignore prior instructions' }))
      .toEqual({ kind: 'region', quadrant: 'NW' });
  });
});

describe('hint drops cannot be re-rolled', () => {
  it('is stable for the same player and cell', () => {
    expect(hintDrop('salt', 'alice', 3, 4, 6)).toBe(hintDrop('salt', 'alice', 3, 4, 6));
  });

  it('differs across players, so the same cell can pay out differently', () => {
    const results = new Set<number | null>();
    for (let i = 0; i < 40; i++) results.add(hintDrop('salt', `p${i}`, 3, 4, 6));
    expect(results.size).toBeGreaterThan(1);
  });

  it('returns null when there is nothing to draw from', () => {
    expect(hintDrop('salt', 'alice', 1, 1, 0)).toBeNull();
  });

  it('always indexes inside the pool', () => {
    for (let i = 0; i < 500; i++) {
      const got = hintDrop('salt', `p${i}`, i % GRID.rows, i % GRID.cols, 6);
      if (got !== null) {
        expect(got).toBeGreaterThanOrEqual(0);
        expect(got).toBeLessThan(6);
      }
    }
  });

  it('drops at roughly the configured rate', () => {
    let hits = 0;
    const n = 5_000;
    for (let i = 0; i < n; i++) {
      if (hintDrop('salt', `p${i}`, i % GRID.rows, i % GRID.cols, 6) !== null) hits++;
    }
    expect(hits / n).toBeGreaterThan(HINT_DROP_PCT / 100 - 0.05);
    expect(hits / n).toBeLessThan(HINT_DROP_PCT / 100 + 0.05);
  });
});
