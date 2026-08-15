import { describe, expect, it } from 'vitest';
import {
  ALPHA,
  MIN_DISTINCT_HINTS,
  MIN_SHORTFALL,
  canonicalEvidence,
  judge,
  lowerTail,
  type SoldHint,
} from './validation';

/**
 * Deciding whether to take somebody's money.
 *
 * The bar is higher than for anything else in this codebase, because the failure
 * mode is not a bad game or a lost trade — it is confiscating a bond from a
 * seller who did nothing wrong. So these tests are mostly about what must NOT be
 * called fraud: bad luck, small samples, the product working as advertised, and
 * one unlucky hint that happened to sell well.
 */

const hint = (over: Partial<SoldHint> = {}): SoldHint => ({
  hintId: `h_${Math.random().toString(36).slice(2)}`,
  huntId: 'hunt_1',
  reliabilityBps: 7_000,
  isTrue: true,
  sales: 1,
  paidCents: 20,
  ...over,
});

/** `n` hints at one reliability, `trueCount` of which came out true. */
const run = (n: number, trueCount: number, reliabilityBps = 7_000, sales = 1): SoldHint[] =>
  Array.from({ length: n }, (_, i) =>
    hint({ hintId: `h${i}`, reliabilityBps, isTrue: i < trueCount, sales }),
  );

/** Deterministic PRNG, so the calibration below is a fact rather than a mood. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('the arithmetic', () => {
  it('matches the binomial where the two agree', () => {
    // Ten fair coins: P(X <= 3) = (1+10+45+120)/1024.
    expect(lowerTail(Array(10).fill(0.5), 3)).toBeCloseTo(176 / 1024, 12);
    expect(lowerTail(Array(10).fill(0.5), 10)).toBeCloseTo(1, 12);
    expect(lowerTail(Array(10).fill(0.5), -1)).toBeCloseTo(0, 12);
  });

  it('handles different probabilities per trial', () => {
    // Not a binomial: a 90% hint and a 50% hint are different trials, and
    // averaging them would be a different distribution with different tails.
    const mixed = lowerTail([0.9, 0.5], 0);
    expect(mixed).toBeCloseTo(0.1 * 0.5, 12);
  });

  it('is a probability, always', () => {
    for (const ps of [[], [0], [1], [0.3, 0.7, 0.99, 0.01]]) {
      for (let k = -1; k <= ps.length + 1; k++) {
        const p = lowerTail(ps, k);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('what must not be called fraud', () => {
  it('does not punish a false hint', () => {
    // Hints are sold as probabilistic. A tier-3 hint being false is the product
    // working exactly as advertised, and fining a seller for it would be fining
    // them for randomness the house generated.
    const verdict = judge('s', [hint({ reliabilityBps: 5_000, isTrue: false })]);
    expect(verdict.slashable).toBe(false);
  });

  it('refuses to judge a small sample at all', () => {
    // Every hint false, at 50% reliability — damning-looking and perfectly
    // possible by chance.
    const verdict = judge('s', run(MIN_DISTINCT_HINTS - 1, 0, 5_000));
    expect(verdict.slashable).toBe(false);
    expect(verdict.reason).toBe('too_few_hints');
  });

  it('leaves an ordinary unlucky seller alone', () => {
    // 20 tier-2 hints, 11 true against 14 expected. A bad week.
    const verdict = judge('s', run(20, 11));
    expect(verdict.slashable).toBe(false);
    expect(verdict.reason).toBe('within_expectation');
  });

  it('does not convict on a large sample with a small shortfall', () => {
    // The failure mode a p-value alone eventually produces: enough sales that a
    // hair under expectation becomes statistically significant. That is bad luck
    // with a big sample, not fraud, and taking a bond for it would be a bug that
    // looks like rigour.
    const verdict = judge('s', run(900, 567)); // expected 630, shortfall 10%
    expect(verdict.pValue).toBeLessThan(ALPHA);
    expect(verdict.slashable).toBe(false);
    expect(verdict.reason).toBe('shortfall_too_small');
  });

  it('counts one unlucky hint once, however many buyers it had', () => {
    // THE statistical trap. The same hint sold twenty times shares one outcome;
    // treating those as twenty trials turns one piece of bad luck into
    // overwhelming evidence and convicts an honest seller who listed something
    // popular.
    const popular = [
      ...run(7, 7),
      hint({ hintId: 'unlucky', isTrue: false, sales: 20, paidCents: 400 }),
    ];

    const verdict = judge('s', popular);
    expect(verdict.distinctHints).toBe(8);
    expect(verdict.sales).toBe(27);
    expect(verdict.slashable).toBe(false);
  });
});

describe('what is fraud', () => {
  it('catches a seller who only ever sold false hints', () => {
    // Adverse selection at its most blatant: they knew which ones were false and
    // sold exactly those.
    const verdict = judge('s', run(12, 0));
    expect(verdict.pValue).toBeLessThan(ALPHA);
    expect(verdict.slashable).toBe(true);
    expect(verdict.reason).toBe('slashable');
  });

  it('catches heavy but not total rigging', () => {
    const verdict = judge('s', run(20, 4)); // 4 true against 14 expected
    expect(verdict.slashable).toBe(true);
  });

  it('counts harm over trades even though it judges over hints', () => {
    // The evidence is the distinct hints; the money is the sales. A seller who
    // sold one false hint to thirty buyers did thirty buyers' worth of harm.
    const verdict = judge('s', [
      ...run(11, 0),
      hint({ hintId: 'mass', isTrue: false, sales: 30, paidCents: 600 }),
    ]);

    expect(verdict.distinctHints).toBe(12);
    expect(verdict.harmCents).toBe(11 * 20 + 600);
  });

  it('weighs a broken promise by how strong the promise was', () => {
    // Twelve false tier-1 hints (90% each) is far less likely than twelve false
    // tier-3 hints, and the verdict must reflect that rather than counting heads.
    const strong = judge('s', run(12, 0, 9_000));
    const weak = judge('s', run(12, 0, 5_000));
    expect(strong.pValue).toBeLessThan(weak.pValue);
  });
});

describe('calibration', () => {
  /** One simulated seller. `cheatRate` is the share of sales they rigged. */
  function seller(rand: () => number, n: number, cheatRate: number): SoldHint[] {
    const tiers = [9_000, 7_000, 5_000];
    return Array.from({ length: n }, (_, i) => {
      const reliabilityBps = tiers[Math.floor(rand() * 3)]!;
      const rigged = rand() < cheatRate;
      return hint({
        hintId: `h${i}`,
        reliabilityBps,
        isTrue: rigged ? false : rand() < reliabilityBps / 10_000,
      });
    });
  }

  const flagRate = (n: number, cheatRate: number, trials = 3_000): number => {
    const rand = rng(20260815);
    let flagged = 0;
    for (let t = 0; t < trials; t++) {
      if (judge('s', seller(rand, n, cheatRate)).slashable) flagged += 1;
    }
    return flagged / trials;
  };

  it('almost never accuses an honest seller', () => {
    // Every seller is tested every round, so the question is not "could this one
    // be unlucky" but "could ANY of them be". Measured at 0.03–0.06%.
    for (const n of [8, 20, 40]) {
      expect(flagRate(n, 0), `${n} hints`).toBeLessThan(0.005);
    }
  });

  it('catches the blatant cheat almost every time', () => {
    expect(flagRate(12, 1)).toBeGreaterThan(0.9);
    expect(flagRate(20, 1)).toBeGreaterThan(0.95);
  });

  it('catches heavy rigging once there is enough evidence', () => {
    expect(flagRate(20, 0.75)).toBeGreaterThan(0.8);
    expect(flagRate(40, 0.5)).toBeGreaterThan(0.7);
  });

  it('is deliberately blind to rigging below the effect-size floor', () => {
    // Documented rather than hidden, and asserted so nobody "fixes" it by
    // lowering MIN_SHORTFALL without understanding the exchange. At a 25% cheat
    // rate the realised shortfall settles near 0.25 and never crosses the 0.35
    // floor — so more evidence lowers the p-value while the effect size stays
    // under the bar, and detection does not improve with sample size.
    expect(MIN_SHORTFALL).toBe(0.35);
    expect(flagRate(80, 0.25)).toBeLessThan(0.35);
    // The price of catching this seller is confiscating from honest ones.
    expect(flagRate(80, 0)).toBeLessThan(0.005);
  });
});

describe('the evidence', () => {
  it('is identical however the rows arrive', () => {
    // A seller disputing a slash has to be able to rebuild the same bytes
    // somewhere else. Row order out of SQLite is not a promise.
    const sold = run(10, 6);
    const verdict = judge('s', sold);

    expect(canonicalEvidence(verdict, sold)).toBe(
      canonicalEvidence(verdict, [...sold].reverse()),
    );
  });

  it('changes when any of the facts change', () => {
    const sold = run(10, 6);
    const other = run(10, 5);
    expect(canonicalEvidence(judge('s', sold), sold)).not.toBe(
      canonicalEvidence(judge('s', other), other),
    );
  });

  it('carries every hint the verdict rested on', () => {
    const sold = run(9, 2);
    const evidence = canonicalEvidence(judge('s', sold), sold);
    for (const h of sold) expect(evidence).toContain(h.hintId);
  });
});
