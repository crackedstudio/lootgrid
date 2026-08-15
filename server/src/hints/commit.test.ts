import { describe, expect, it } from 'vitest';
import { hintsForHunt } from './generate';
import {
  COMMIT_VERSION,
  MIN_SAMPLE,
  accuracyByTier,
  canonicalHint,
  canonicalPayload,
  commitmentFor,
  verifyCommitment,
  withinAdvertised,
} from './commit';
import { TIER_RELIABILITY_BPS, type HintRecord } from './types';
import type { Hunt } from '../types';

/**
 * The commitment is what turns "the house lied to me" from an unfalsifiable
 * accusation into a checkable number. These tests are the guarantee: if any of
 * them can be made to pass while the house cheats, the scheme is decorative.
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
    difficulty: 'med',
    prizeLabel: '$1.00',
    status: 'live',
    winnerId: null,
    game: null,
    expiresAt: 2_000_000,
    createdAt: 1_000_000,
    ...over,
  } as Hunt;
}

describe('the commitment binds the set', () => {
  it('accepts the set it was made from', () => {
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const c = commitmentFor(hunt.id, hunt.salt, set);
    expect(verifyCommitment(c, hunt.id, hunt.salt, set)).toBe(true);
  });

  it('rejects a flipped truth flag', () => {
    // The attack the whole scheme exists to stop: reveal a hint as false after
    // the fact to explain why the player did not find the hunt.
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const c = commitmentFor(hunt.id, hunt.salt, set);

    const tampered = set.map((h, i) => (i === 0 ? { ...h, isTrue: !h.isTrue } : h));
    expect(verifyCommitment(c, hunt.id, hunt.salt, tampered)).toBe(false);
  });

  it('rejects an altered payload', () => {
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const c = commitmentFor(hunt.id, hunt.salt, set);

    const tampered = set.map((h, i) =>
      i === 0 ? { ...h, payload: { kind: 'parity', parity: 'even' } as const } : h,
    );
    expect(verifyCommitment(c, hunt.id, hunt.salt, tampered)).toBe(false);
  });

  it('rejects a quietly revised reliability promise', () => {
    // Advertising 70% and later claiming 50% was always the deal would make the
    // audit unfalsifiable. The promise is inside the digest.
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const c = commitmentFor(hunt.id, hunt.salt, set);

    const tampered = set.map((h, i) => (i === 0 ? { ...h, reliabilityBps: 1 } : h));
    expect(verifyCommitment(c, hunt.id, hunt.salt, tampered)).toBe(false);
  });

  it('rejects added or removed hints', () => {
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const c = commitmentFor(hunt.id, hunt.salt, set);

    expect(verifyCommitment(c, hunt.id, hunt.salt, set.slice(1))).toBe(false);
    expect(verifyCommitment(c, hunt.id, hunt.salt, [...set, set[0]!])).toBe(false);
  });

  it('rejects a substituted salt', () => {
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const c = commitmentFor(hunt.id, hunt.salt, set);
    expect(verifyCommitment(c, hunt.id, 'different-salt', set)).toBe(false);
  });

  it('rejects a set moved to another hunt', () => {
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const c = commitmentFor(hunt.id, hunt.salt, set);
    expect(verifyCommitment(c, 'hunt-2', hunt.salt, set)).toBe(false);
  });
});

describe('the digest is portable', () => {
  it('does not depend on the order rows come back in', () => {
    // Storage order is an implementation detail; a verifier reimplementing this
    // must not have to reproduce our ORDER BY.
    const hunt = makeHunt();
    const set = hintsForHunt(hunt);
    const shuffled = [...set].reverse();
    expect(commitmentFor(hunt.id, hunt.salt, shuffled)).toBe(
      commitmentFor(hunt.id, hunt.salt, set),
    );
  });

  it('encodes payloads without relying on key order', () => {
    // Not JSON.stringify: key order there varies by runtime, and a commitment
    // that depends on it is not portable.
    expect(canonicalPayload({ kind: 'region', quadrant: 'NW' })).toBe('region|NW');
    expect(canonicalPayload({ kind: 'distance', r: 4, c: 3, within: 1 })).toBe('distance|4|3|1');
    expect(canonicalPayload({ kind: 'rowBand', from: 2, to: 6 })).toBe('rowBand|2|6');
  });

  it('puts every consequential field in the encoding', () => {
    const h = hintsForHunt(makeHunt())[0]!;
    const encoded = canonicalHint(h);
    for (const part of [String(h.idx), String(h.tier), String(h.reliabilityBps)]) {
      expect(encoded).toContain(part);
    }
  });

  it('carries a version tag so future encodings stay checkable', () => {
    expect(COMMIT_VERSION).toMatch(/^lootgrid:hints:v\d+$/);
  });

  it('is stable across runs', () => {
    const hunt = makeHunt();
    expect(commitmentFor(hunt.id, hunt.salt, hintsForHunt(hunt))).toBe(
      commitmentFor(hunt.id, hunt.salt, hintsForHunt(hunt)),
    );
  });
});

describe('accuracy accounting', () => {
  function setOf(tier: 1 | 2 | 3, trues: number, falses: number): HintRecord[] {
    const mk = (isTrue: boolean, i: number) =>
      ({
        id: `x:${i}`,
        huntId: 'x',
        zoneId: 'ridge',
        epoch: 1,
        idx: i,
        tier,
        reliabilityBps: TIER_RELIABILITY_BPS[tier],
        payload: { kind: 'parity', parity: 'even' } as const,
        isTrue,
        expiresAt: null,
      }) as HintRecord;
    return [
      ...Array.from({ length: trues }, (_, i) => mk(true, i)),
      ...Array.from({ length: falses }, (_, i) => mk(false, trues + i)),
    ];
  }

  it('refuses to judge a sample too thin to mean anything', () => {
    // The defect this caught in practice: over two hints, one lie reads as 50%
    // against 70% advertised and a naive check screams fraud. An audit that
    // cries wolf on noise teaches everyone to ignore it.
    const thin = accuracyByTier(setOf(2, 1, 1))[0]!;
    expect(thin.judged).toBe(false);
    expect(withinAdvertised(thin)).toBe(true);

    const thick = accuracyByTier(setOf(2, 35, 35))[0]!;
    expect(thick.judged).toBe(true);
    expect(withinAdvertised(thick)).toBe(false);
  });

  it('marks a tier judged only once it clears the threshold', () => {
    expect(accuracyByTier(setOf(1, MIN_SAMPLE - 1, 0))[0]!.judged).toBe(false);
    expect(accuracyByTier(setOf(1, MIN_SAMPLE, 0))[0]!.judged).toBe(true);
  });

  it('computes observed rate per tier', () => {
    const [acc] = accuracyByTier(setOf(2, 70, 30));
    expect(acc!.tier).toBe(2);
    expect(acc!.observedBps).toBe(7_000);
    expect(acc!.advertisedBps).toBe(TIER_RELIABILITY_BPS[2]);
    expect(acc!.total).toBe(100);
  });

  it('passes when observed meets or beats advertised', () => {
    expect(withinAdvertised(accuracyByTier(setOf(2, 70, 30))[0]!)).toBe(true);
    // Above advertised is a gift to the player and needs no defence.
    expect(withinAdvertised(accuracyByTier(setOf(2, 95, 5))[0]!)).toBe(true);
  });

  it('fails when the house lied more than it said it would', () => {
    // 40% observed against 70% advertised. This is the alarm.
    expect(withinAdvertised(accuracyByTier(setOf(2, 40, 60))[0]!)).toBe(false);
  });

  it('tolerates jitter around the advertised rate but not a real shortfall', () => {
    expect(withinAdvertised(accuracyByTier(setOf(2, 67, 33))[0]!)).toBe(true);
    expect(withinAdvertised(accuracyByTier(setOf(2, 60, 40))[0]!)).toBe(false);
  });

  it('reports tiers separately, so one cannot mask another', () => {
    const mixed = [...setOf(1, 90, 10), ...setOf(3, 20, 80)];
    const accs = accuracyByTier(mixed);
    expect(accs).toHaveLength(2);
    expect(withinAdvertised(accs.find(a => a.tier === 1)!)).toBe(true);
    expect(withinAdvertised(accs.find(a => a.tier === 3)!)).toBe(false);
  });
});

describe('end to end over many hunts', () => {
  it('commits, reveals and audits honestly at scale', () => {
    const all: HintRecord[] = [];
    for (let i = 0; i < 800; i++) {
      const hunt = makeHunt({ id: `h${i}`, salt: `s${i}`, r: i % 18, c: (i * 5) % 12 });
      const set = hintsForHunt(hunt);
      const commitment = commitmentFor(hunt.id, hunt.salt, set);
      // What a player does after the hunt: regenerate and check.
      expect(verifyCommitment(commitment, hunt.id, hunt.salt, hintsForHunt(hunt))).toBe(true);
      all.push(...set);
    }

    for (const acc of accuracyByTier(all)) {
      expect(withinAdvertised(acc), `tier ${acc.tier} came in below advertised`).toBe(true);
    }
  });
});
